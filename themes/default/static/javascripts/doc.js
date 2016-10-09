/**
 * @file 文档页js
 * */
var $win = $(window);
var $navs = $('.docx-navs');
var $navbarH = $('.navbar').height();
var $docxTitle = $('.docx-files');
var $docxBd = $('.docx-body');
var $docxDir = $('.docx-dir>a');
var $searchIpt = $('.docx-searchkey');
var $sug = $('.docx-sug');
var $sugul = $('.docx-sugul');
var actCls = 'docx-sugact';
/**
 * 兼容老平台
 * */
var hash = location.hash || '';
var path;
// 兼容老链接
if (path = /^(^#\/){1}(.+)/.exec(hash)) {
    if (Array.isArray(path)) {
        $.getJSON({
            url: '/javascripts/patch.json'
        }).done(function (data) {
            if (!$.isEmptyObject(data)) {
                var pathStr = path[2] || '';
                var pathSep = pathStr.split('/');
                var rsPath = pathSep.map(function (it) {
                    return data[it.replace('+', ' ')] || it;
                }).join('/');
                location.href = rsPath + '.md';
            }
        });
    }
}

/**
* pjax委托
* */
if ($.support.pjax) {
    $(document).pjax('a[href^="/"]', '.docx-marked-wrap');
    // 使用pjax更底层的方法,可控性更强
    /*$(document).on('click', 'a[href^="/"]', function(event) {
        var container = $docxBd.find('.docx-marked-wrap');
        $.pjax.click(event, {container: container})
    });*/
    $(document).on('pjax:complete', function() {
        $('.docx-fade').addClass('docx-fade-active');
        $sug.hide();
    });
}

$win.load(function () {
    $('.docx-fade').addClass('docx-fade-active');

    $win.on('resize', function () {
        $docxBd.height($win.height() - $navbarH);
    });

    $docxBd.height($win.height() - $navbarH);
});

/**
 * 搜索action
 * */
$searchIpt.on('input', function (e) {
    var key =$searchIpt.val();
    key ? $sug.show() : $sug.hide();
    $.ajax({
        url: '/api/search',
        data: {
            name: key,
            type: 'title'
        },
        type: 'post'
    }).done(function (data) {
        var rsData = data.data;
        var htmlStr = '';
        if (Array.isArray(rsData) && rsData.length) {
            rsData.slice(0, 10).forEach(function (it) {
                htmlStr +=  '<li><a href="'+ it.path +'">'+ it.title +'</a></li>';
            });
        }
        htmlStr += '<li class="docx-fullse"><a href="#">全文搜索<span class="hljs-string">' + key + '</span></a></li>';
        $sugul.html(htmlStr);
    });
});

$docxBd.on('click', '.docx-fullse', function () {
    var key = $searchIpt.val();
    $.ajax({
        url: '/api/search',
        data: {
            name: key
        },
        type: 'post'
    }).done(function (data) {
        var rsData = data.data;
        var htmlStr = '';
        var emptyString = '<div class="docx-search-nocontent">暂无匹配文档!</div>';
        if (Array.isArray(rsData) && rsData.length) {
            rsData.forEach(function (it) {
                var content = it.content || '';
                content = content.replace(/<(table).*?<\/\1>|<table.*?>|<\/table>/g,'');
                htmlStr +=  [
                    '<div class="docx-search-art">',
                    '    <div class="docx-search-title">',
                    '        <a href="' + it.path + '" class="doc-search-link">',
                    it.title,
                    '        </a>',
                    '    </div>',
                    '    <div class="docx-search-content">',
                    '        <a href="' + it.path + '" class="doc-search-link">',
                    content,
                    '        </a>',
                    '    </div>',
                    '</div>'
                ].join('');
            });
            $sug.hide();
        }
        $('.docx-marked').html(htmlStr ? htmlStr : emptyString);
    });
});

// 初始化文档目录菜单
$navs.metisMenu({
    preventDefault: false
});

$(window).on('load', function(event) {
    var pathname = location.pathname || '';
    var $pathDom = $('[data-path="'+ pathname +'"]');
    $pathDom.parents('.docx-submenu').addClass('in');
    $pathDom.parents('[data-dir]').addClass('active subactive');
    $docxTitle.removeClass('docx-active');
    $pathDom.addClass('docx-active').parents().remove('docx-active');
});

$docxTitle.add($docxDir).on('click', function () {
    $('.docx-active').removeClass('docx-active');
    $(this).addClass('docx-active');
});

$searchIpt.on('keydown', function (e) {
    var keyCode = e.keyCode;
    var $lis = $('.docx-sugul>li');
    var $act = $('.docx-sugact');
    if (keyCode === 38) {
        if ($act.length === 0) {
            $lis.last().addClass(actCls);
        } else if (!$act.is(':first-child')){
            $act.removeClass().prev().addClass(actCls);
        }
        else {
            $act.removeClass();
            $lis.last().addClass(actCls);
        }
    }
    else if(keyCode === 40){
        if ($act.length === 0) {
            $lis.first().addClass(actCls);
        } else if (!$act.is(':last-child')){
            $act.removeClass().next().addClass(actCls);
        }
        else {
            $act.removeClass();
            $lis.first().addClass(actCls);
        }
    }
    else if (keyCode === 13) {
        if ($lis.length == 1) {
            $lis.click();
            $sug.hide();
        }
        $act.find('a').click();
    }
});