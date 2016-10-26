/**
 * @file docx.js
 * @description 文档平台主文件
 * @author schoeu
 * */

var path = require('path');
var fs = require('fs-extra');
var url = require('url');
var child_process = require('child_process');
var LRU = require("lru-cache");
var express = require('express');
var bodyParser = require('body-parser');
var _ = require('lodash');
var hbs = require('express-hbs');

var warning = require('./warning.js');
var utils = require('./utils.js');
var log = require('./logger.js');

// 文件预处理
var preprocessor = require('./preprocessor.js');
var searchModule = require('./search.js');
var search;
var cache = LRU({max: 500});

var app = express();

var htmlStr = '';
var CONF = {};
var searchFn = {};
var isUpdated = false;
var HBS_EXTNAME = 'hbs';

// 默认配置,减少配置文件条目数,增加易用性与容错
var defaultOptions = {
    logPath: './log',
    dirsConfName: 'map.json',
    port: '8910',
    logLevel: 'info',
    index: '/readme.md',
    theme: 'default',
    preprocessScript: '',
    cacheDir: './cache.json',
    searchConf: {
        matchDeep: 2,
        matchWidth: 120
    },
    extUrls: {},
    waringFlag: false,
    debug: true,
    ignoreDir: []
};

/**
 * Docx构造函数
 *
 * @param {String} conf 配置文件相对路径
 * */
function Docx(conf) {
    // 初始化docx
    this.init(conf);
}

var errorType = {'notfound': '/images/notfound.png', 'othererror': '/images/othererror.png'};
var compiledPageCache = {};

Docx.prototype = {
    contributor: Docx,

    /**
     * 初始化DOCX,主要初始化了express,日志模块, 预处理模块, 路由绑定等
     * */
    init: function (conf) {
        var me = this;

        // 获取配置
        var confPara = me.getConf(conf);
        var docPath = confPara.path;

        if (!docPath) {
            throw new Error('not valid conf file.');
        }
        else {
            // 文件绝对&相对路径兼容
            if (!path.isAbsolute(docPath)) {
                docPath = path.join(process.cwd(), docPath);
            }
        }

        // 合并配置
        CONF = Object.assign({
            docPath: docPath
        }, defaultOptions, confPara);

        // 日志路径设置
        me.logger = log(CONF);

        // 文件预处理
        preprocessor.init(CONF, me.logger);

        // 文件夹命名设置默认为空
        me.dirname = {};

        // 公共变量处理
        if (!_.isEmpty(CONF)) {
            var headText = CONF.headText || '';
            me.ignorDor = CONF.ignoreDir;
            me.locals = {
                headText: headText || '',
                title: CONF.title || headText,
                links: CONF.extUrls.links || [],
                supportInfo: CONF.supportInfo || '',
                label: CONF.extUrls.label
            };

            // 返回搜索方法
            searchFn = searchModule(CONF);

            // 读取缓存,用于搜索
            searchFn.readCache();

            search = searchFn.search;

            // 如果邮件报警开启,则初始化邮件报警模块
            if (CONF.waringFlag) {
                me.mail = warning(CONF);
            }
        }
        else {
            throw new Error('conf file is empty.');
        }

        // express 视图设置
        if (!CONF.debug) {
            app.enable('view cache');
        }

        var themePath = path.join(__dirname, '..', 'themes', CONF.theme);
        me.themePath = path.join(themePath, 'views');

        app.engine('hbs', hbs.express4({
            partialsDir: me.themePath
        }));
        app.set('view engine', HBS_EXTNAME);
        app.set('views', me.themePath);

        app.use(express.static(path.join(themePath, 'static')));
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({extended: false}));

        // 在构建doctree前解析文件名命令配置
        var dirsConf = path.join(CONF.docPath, CONF.dirsConfName);
        try {
            var stat = fs.statSync(dirsConf);
            if (stat) {
                me.dirname = require(dirsConf);
            }
        }
        catch (e) {}

        // 根据文档获取文档结构树
        me.getDocTree();

        // 路由处理
        me.routes();

        // 端口监听
        app.listen(CONF.port || 8910);
    },

    /**
     * 配置处理
     *
     * @param {String} conf 配置文件相对路径
     * @return {undefined}
     * */
    getConf: function (conf) {

        conf = conf ? conf : './docx-conf.json';

        // 配置文件设置,如果是绝对路径,则使用绝对路径,如果是相对路径,则计算出最终路径
        if (!path.isAbsolute(conf)) {
            conf = path.join(process.cwd(), conf);
        }

        // 读取配置内容
        var json = fs.readJsonSync(conf);

        return json || '';
    },

    /**
     * 系统的路由定义
     * */
    routes: function () {
        var me = this;

        // 文档主路径
        app.get('/', function (req, res) {
            res.redirect(CONF.index);
        });

        // markdown文件路由
        app.get(/.+.md$/, me.mdHandler.bind(me));

        // API: 搜索功能
        app.post('/api/search', function (req, res) {
            var key = req.body.name;
            var searchType = req.body.type;
            var searchRs = search(searchType, key);

            // 搜索成功,返回内容
            res.json({
                data: searchRs
            });
        });

        // API: 文档更新钩子
        app.all('/api/update', me.update.bind(me));

        // 委托其他静态资源
        app.use('/', express.static(CONF.docPath));

        // 路由容错处理
        app.get('*', function (req, res) {
            var time = Date.now();
            var ua = req.headers['user-agent'] || '';
            // 错误页面
            var errPg = me.compilePre('error', {errorType: errorType['notfound']});
            var errPgObj = Object.assign({}, me.locals, {navData: htmlStr, mdData: errPg});
            res.render('main', errPgObj);
            me.logger.error({'access:': req.url, 'isCache:': false, error: 'notfound', ua: ua, during: Date.now() - time + 'ms'});
        });

        // 容错处理
        app.use(function(err, req, res, next) {
            res.status(err.status || 500);
            // 错误页面
            var errPg = me.compilePre('error', {errorType: errorType['othererror']});
            var errPgObj = Object.assign({}, me.locals, {navData: htmlStr, mdData: errPg});
            res.render('main', errPgObj);
            me.logger.error(err);
        });
    },

    /**
     * 处理&组装面包屑数据
     * @param {String} pathName 文件路径
     * @param {String} content markdown内容
     * @return {String} 转换为中文的HTML字符串
     * */
    getPjaxContent: function (pathName, content) {
        var me = this;
        var brandStr = '';
        var pathArr = pathName.split('/');
        var brandData = me.processBreadcrumb(pathArr);
        brandData.forEach(function (it) {
            brandStr += '<li>' + it + '</li>';
        });
        //var rsHTML = htmlCodes.replace('{{brandData}}', brandStr).replace('{{mdData}}', content);
        var rsHTML = me.compilePre('pjax', {brandData: brandStr, mdData: content});
        return rsHTML;
    },

    /**
     * 处理mardown文档请求
     * @param {Object} req 请求对象
     * @param {Object} res 相应对象
     * */
    mdHandler: function (req, res, next) {
        var me = this;
        var ua = req.headers['user-agent'] || '';
        var time = Date.now();

        if (isUpdated) {
            // 刷新缓存
            preprocessor.init(CONF, me.logger);

            // 重新生成DOM树
            me.getDocTree();

            // 重新读取缓存,用于刷新搜索
            searchFn.readCache();

            // 更新状态
            isUpdated = false;
        }
        var relativePath = url.parse(req.originalUrl);
        var pathName = relativePath.pathname || '';
        var mdPath = path.join(CONF.docPath, pathName);
        var isPjax = req.headers['x-pjax'] === 'true';
        mdPath = decodeURIComponent(mdPath);
        fs.readFile(mdPath, 'utf8', function (err, file) {
            var content = '';
            if (file) {
                // 请求页面是否在缓存中
                var hasCache = cache.has(pathName);

                if(hasCache) {
                    content = cache.get(pathName);
                }
                else  {
                    // markdown转换成html
                    content = utils.getMarked(file.toString());

                    // 有内容才缓存
                    content && cache.set(pathName, content);
                }

                // 判断是pjax请求则返回html片段
                if (isPjax) {
                    var rsPjaxDom = me.getPjaxContent(pathName, content);
                    res.end(rsPjaxDom);
                }
                // 否则返回整个模板
                else {
                    var parseObj = Object.assign({}, me.locals, {navData: htmlStr, mdData: content});
                    res.render('main', parseObj);
                }
                me.logger.info({'access:': pathName, 'isCache:': hasCache, error: null, ua: ua, during: Date.now() - time + 'ms'});
            }
            // 如果找不到文件,则返回错误提示页
            else if (err) {
                // 错误页面
                var errPg =me.compilePre('error', {errorType: errorType['notfound']});

                // 判断是pjax请求则返回html片段
                if (isPjax) {
                    res.end(me.getPjaxContent(pathName, errPg));
                }
                // 否则返回整个模板
                else {
                    var errPgObj = Object.assign({}, me.locals, {navData: htmlStr, mdData: errPg});
                    res.render('main', errPgObj);
                }
                me.logger.error(err);
            }
        });
    },

    /**
     * 处理&组装面包屑数据
     * @param {Array} breadcrumb 面包屑原始数据
     * @return {Array} 转换为中文的数据
     * */
    processBreadcrumb: function(breadcrumb) {
        var me = this;
        breadcrumb = breadcrumb || [];
        var dirMaps = [];
        breadcrumb.forEach(function (it) {
            if (it && it.indexOf('.md') < 0) {
                var nameMap = me.dirname[it] || {};
                dirMaps.push(nameMap.name || '');
            }
        });
        return dirMaps;
    },

    /**
     * 获取文件目录树
     * */
    getDocTree: function () {
        // 根据markdown文档生成文档树
        var dirMap = this.walker(CONF.docPath);

        // 根据配置规则对文档进行排序
        var dirRsMap = this.dirSort(dirMap);

        // 根据排序后的文档树数据生成文档DOM
        htmlStr = '';
        this.makeNav(dirRsMap);
    },

    /**
     * 获取文件目录树
     *
     * @param {String} 文档根目录路径
     * @return {Object} 文件目录树
     * */
    walker: function (dirs) {
        var me = this;
        var testArr = [];
        docWalker(dirs, testArr);
        function docWalker(dirs, dirCtt) {
            var dirArr = fs.readdirSync(dirs);
            dirArr = dirArr || [];
            dirArr.forEach(function(it) {
                var childPath = path.join(dirs, it);
                var stat = fs.statSync(childPath);
                var relPath = childPath.replace(CONF.docPath, '');
                // 如果是文件夹就递归查找
                if (stat.isDirectory()) {

                    // 如果是配置中忽略的目录,则跳过
                    if (me.ignorDor.indexOf(it) === -1) {
                        var dirName = me.dirname[it] || {};
                        // 如果没有配置文件夹目录名称,则不显示
                        var childArr = [];
                        dirCtt.push({
                            itemName: it,
                            type: 'dir',
                            path: relPath,
                            displayName: dirName.name || it ||'',
                            child: childArr
                        });
                        docWalker(childPath, childArr);
                    }
                }
                // 如果是文件
                else {

                    if (/^\.md$|html$|htm$/i.test(path.extname(it))) {
                        var basename = path.basename(it, path.extname(it));
                        var title = utils.getMdTitle(childPath);
                        dirCtt.push({
                            itemName: basename,
                            type: 'file',
                            path: relPath,
                            title: title
                        });
                    }
                }
            });
        }
        return testArr;
    },

    /**
     * 根据文件目录数据组装文件html
     *
     * @param {Array} dirs 文件目录数组
     * */
    makeNav: function (dirs) {
        if (Array.isArray(dirs) && dirs.length) {
            for(var i = 0; i< dirs.length; i++) {
                var item = dirs[i] || {};
                if (!item) {
                    continue;
                }
                if (item.type === 'file') {
                    htmlStr += '<li class="nav nav-title docx-files" data-path="' + item.path + '" data-title="' + item.title + '"><a href="' + item.path + '">' + item.title + '</a></li>';
                }
                else if (item.type === 'dir') {
                    htmlStr += '<li data-dir="' + item.path + '" data-title="' + item.displayName + '" class="docx-dir"><a href="#" class="docx-dirsa">' + item.displayName + '<span class="fa arrow"></span></a><ul class="docx-submenu">';
                    this.makeNav(item.child);
                    htmlStr += '</ul></li>';
                }
            }
        }
    },

    /**
     * 根据配置对文档进行排序,暂支持根目录文件夹排序
     *
     * @param {Object} map 文档结构数据
     * @return {Object} rs 排序后的文档结构数组
     * */
    dirSort: function (map) {
        var me = this;
        map = map || [];
        var dirname = me.dirname || {};
        if (!_.isEmpty(dirname)) {
            var sortMap = [];
            var rs = [];
            var fileArr = [];
            map.forEach(function (it) {
                var item = dirname[it.itemName] || {};
                if (it.type !== 'dir') {
                    item.sort = 0;
                }
                sortMap.push(item.sort || 0);
            });

            sortMap.sort(function (a, b) {return a - b});

            map.forEach(function (it) {
                var itemName = dirname[it.itemName] || {};
                var sortNum = itemName.sort || 0;
                if (it.type !== 'dir') {
                    fileArr.push(it);
                }
                else {
                    var index = sortMap.indexOf(sortNum);
                    rs[index] = it;
                }
            });

            return fileArr.concat(rs);
        }
        return map;
    },

    /**
     * 文档更新钩子
     *
     * @param {Object} req 请求对象
     * @return {Object} res 响应对象
     * */
    update: function (req, res) {
        var me = this;
        var time = Date.now();

        // 更新代码
        child_process.exec('git pull', {
            cwd: CONF.docPath
        }, function (err, result) {
            if (err) {
                me.logger.error(err);
            }
            else {
                // 清除lru缓存
                cache.reset();

                // 清除文件缓存
                isUpdated = true;
                me.logger.info({message: 'update cache.json', during: Date.now() - time + 'ms'});
                res.end('update cache.');
            }
        });
    },

    /**
     * 模板异步编译处理
     *
     * @param {String} 模板名
     * @param {Object} data 替换对象
     * @return {String} html字符串
     * */
    compilePre: function (pagePath, data) {
        var me = this;
        data = data || {};

        // 缓存编译模板
        if (!compiledPageCache[pagePath])  {
            try {
                var compileStr = fs.readFileSync(path.join(me.themePath, pagePath + '.' + HBS_EXTNAME)).toString();
                compiledPageCache[pagePath] = hbs.compile(compileStr);
            }
            catch (e) {
                me.logger.error(e);
                return '';
            }
        }
        return compiledPageCache[pagePath](data);
    }

};

new Docx(process.argv[2]);