/*
Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

'use strict';

// Include Gulp & tools we'll use
var gulp = require('gulp');
var $ = require('gulp-load-plugins')();
var del = require('del');
var runSequence = require('run-sequence');
var browserSync = require('browser-sync');
var reload = browserSync.reload;
var merge = require('merge-stream');
var path = require('path');
var fs = require('fs');
var glob = require('glob');
var historyApiFallback = require('connect-history-api-fallback');
var packageJson = require('./package.json');
var crypto = require('crypto');
var config = require('./config');
var taskDir = './gulp-tasks/';

var styleTask = function (stylesPath, srcs) {
  return gulp.src(srcs.map(function(src) {
      return path.join('app', stylesPath, src);
    }))
    .pipe($.changed(stylesPath, {extension: '.css'}))
    .pipe($.autoprefixer(config.autoprefixer.browsers))
    .pipe(gulp.dest('.tmp/' + stylesPath))
    .pipe($.if('*.css', $.cssmin()))
    .pipe(gulp.dest('dist/' + stylesPath))
    .pipe($.size({title: stylesPath}));
};

// Compile and automatically prefix stylesheets
gulp.task('styles', function () {
  return styleTask('styles', ['**/*.css']);
});

gulp.task('elements', function () {
  return styleTask('elements', ['**/*.css']);
});

// Lint JavaScript
gulp.task('jshint', function () {
  return gulp.src([
      'app/scripts/**/*.js',
      'app/elements/**/*.js',
      'app/elements/**/*.html'
    ])
    .pipe(reload({stream: true, once: true}))
    .pipe($.jshint.extract()) // Extract JS from .html files
    .pipe($.jshint())
    .pipe($.jshint.reporter('jshint-stylish'))
    .pipe($.if(!browserSync.active, $.jshint.reporter('fail')));
});

// Optimize images
gulp.task('images', function () {
  return gulp.src('app/images/**/*')
    .pipe($.cache($.imagemin({
      progressive: true,
      interlaced: true
    })))
    .pipe(gulp.dest('dist/images'))
    .pipe($.size({title: 'images'}));
});

// Copy all files at the root level (app)
gulp.task('copy', function () {
  var app = gulp.src([
    'app/*',
    '!app/test',
    '!app/cache-config.json'
  ], {
    dot: true
  }).pipe(gulp.dest('dist'));

  var bower = gulp.src([
    'bower_components/**/*.{css,html,js}',
    '!bower_components/**/index.html',
    '!bower_components/**/{demo,test}/**/*'
  ]).pipe(gulp.dest('dist/bower_components'));

  var elements = gulp.src(['app/elements/**/*.html'])
    .pipe(gulp.dest('dist/elements'));

  var swBootstrap = gulp.src(['bower_components/platinum-sw/bootstrap/*.js'])
    .pipe(gulp.dest('dist/elements/bootstrap'));

  var swToolbox = gulp.src(['bower_components/sw-toolbox/*.js'])
    .pipe(gulp.dest('dist/sw-toolbox'));

  var vulcanized = gulp.src(['app/elements/elements.html'])
    .pipe($.rename('elements.vulcanized.html'))
    .pipe(gulp.dest('dist/elements'));

  return merge(app, bower, elements, vulcanized, swBootstrap, swToolbox)
    .pipe($.size({title: 'copy'}));
});

// Copy web fonts to dist
gulp.task('fonts', function () {
  return gulp.src(['app/fonts/**'])
    .pipe(gulp.dest('dist/fonts'))
    .pipe($.size({title: 'fonts'}));
});

// Scan your HTML for assets & optimize them
gulp.task('html', function () {
  var assets = $.useref.assets({searchPath: ['.tmp', 'app', 'dist']});

  return gulp.src(['app/**/*.html', '!app/{elements,test}/**/*.html'])
    // Replace path for vulcanized assets
    .pipe($.if('*.html', $.replace('elements/elements.html', 'elements/elements.vulcanized.html')))
    .pipe(assets)
    // Concatenate and minify JavaScript
    .pipe($.if('*.js', $.uglify({preserveComments: 'some'})))
    // Concatenate and minify styles
    // In case you are still using useref build blocks
    .pipe($.if('*.css', $.cssmin()))
    .pipe(assets.restore())
    .pipe($.useref())
    // Minify any HTML
    .pipe($.if('*.html', $.minifyHtml({
      empty: true,  // KEEP empty attributes
      loose: true,  // KEEP one whitespace
      quotes: true, // KEEP arbitrary quotes
      spare: true   // KEEP redundant attributes
    })))
    // Output files
    .pipe(gulp.dest('dist'))
    .pipe($.size({title: 'html'}));
});

// Polybuild will take care of inlining HTML imports,
// scripts and CSS for you.
gulp.task('vulcanize', function () {
  return gulp.src('dist/elements/elements.vulcanized.html')
    .pipe($.vulcanize({
      stripComments: true,
      inlineCss: true,
      inlineScripts: true
    }))
    // Split inline scripts from an HTML file for CSP compliance
    .pipe($.crisper())
    // Minify elements.vulcanized.html
    // https://github.com/PolymerLabs/polybuild/issues/3
    .pipe($.if('*.html', $.htmlmin({
      customAttrAssign: [
        {source:'\\$='}
      ],
      customAttrSurround: [
        [ {source: '\\({\\{'}, {source: '\\}\\}'} ],
        [ {source: '\\[\\['}, {source: '\\]\\]'}  ]
      ],
      removeComments: true,
      collapseWhitespace: true
    })))
    // Remove newline characters
    .pipe($.if('*.html', $.replace(/[\n]/g, '')))
    // Remove 2 or more spaces from CSS
    // (single spaces can be syntactically significant)
    .pipe($.if('*.html', $.replace(/ {2,}/g, '')))
    // Remove CSS comments
    .pipe($.if('*.html', $.stripCssComments({preserve: false})))
    // Minify elements.vulcanized.js
    .pipe($.if('*.js', $.uglify()))
    .pipe(gulp.dest('dist/elements'))
    .pipe($.size({title: 'vulcanize'}));
});

// Generate config data for the <sw-precache-cache> element.
// This include a list of files that should be precached, as well as a (hopefully unique) cache
// id that ensure that multiple PSK projects don't share the same Cache Storage.
gulp.task('cache-config', function (callback) {
  var dir = 'dist';
  var config = {
    cacheId: packageJson.name || path.basename(__dirname),
    disabled: false
  };

  glob('{elements,scripts,styles}/**/*.*', {cwd: dir}, function(error, files) {
    if (error) {
      callback(error);
    } else {
      files.push('index.html', './', 'bower_components/webcomponentsjs/webcomponents-lite.min.js');
      config.precache = files;

      var md5 = crypto.createHash('md5');
      md5.update(JSON.stringify(config.precache));
      config.precacheFingerprint = md5.digest('hex');

      var configPath = path.join(dir, 'cache-config.json');
      fs.writeFile(configPath, JSON.stringify(config), callback);
    }
  });
});

// Clean output directory
gulp.task('clean', function (cb) {
  del(['.tmp', 'dist', 'deploy'], cb);
});

// Watch files for changes & reload
gulp.task('serve', ['styles', 'elements', 'images'], function () {
  browserSync({
    browser: config.browserSync.browser,
    https: config.browserSync.https,
    notify: config.browserSync.notify,
    port: config.browserSync.port,
    logPrefix: 'PSK',
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function (snippet) {
          return snippet;
        }
      }
    },
    server: {
      baseDir: ['.tmp', 'app'],
      middleware: [ historyApiFallback() ],
      routes: {
        '/bower_components': 'bower_components'
      }
    },
    ui: {
      port: config.browserSync.ui.port
    }
  });

  gulp.watch(['app/**/*.html'], reload);
  gulp.watch(['app/styles/**/*.css'], ['styles', reload]);
  gulp.watch(['app/elements/**/*.css'], ['elements', reload]);
  gulp.watch(['app/{scripts,elements}/**/{*.js,*.html}'], ['jshint']);
  gulp.watch(['app/images/**/*'], reload);
});

// Build and serve the output from the dist build
gulp.task('serve:dist', ['default'], function () {
  browserSync({
    browser: config.browserSync.browser,
    https: config.browserSync.https,
    notify: config.browserSync.notify,
    port: config.browserSync.port,
    logPrefix: 'PSK',
    snippetOptions: {
      rule: {
        match: '<span id="browser-sync-binding"></span>',
        fn: function (snippet) {
          return snippet;
        }
      }
    },
    server: 'dist',
    middleware: [ historyApiFallback() ],
    ui: {
      port: config.browserSync.ui.port
    }
  });
});

// Clean dist directory
gulp.task('clean-dist', require(taskDir + 'clean-dist')(del));

// Fetch newest Google analytics.js and replace link to analytics.js
// https://www.google-analytics.com/analytics.js have only 2 hours cache
gulp.task('fetch-newest-analytics',
  require(taskDir + 'fetch-newest-analytics')($, gulp, merge));

// Fix path to sw-toolbox.js
gulp.task('fix-path-sw-toolbox',
  require(taskDir + 'fix-path-sw-toolbox')($, gulp));

// Minify JavaScript in dist directory
gulp.task('minify-dist', require(taskDir + 'minify-dist')($, gulp, merge));

// Static asset revisioning by appending content hash to filenames
gulp.task('revision', require(taskDir + 'revision')($, gulp));

// Build and serve the output from the dist build with GAE tool
gulp.task('serve:gae', ['default'], require(taskDir + 'serve-gae')($, gulp));

// Build Production Files, the Default Task
gulp.task('default', ['clean'], function (cb) {
  runSequence(
    ['copy', 'styles'],
    'elements',
    ['jshint', 'images', 'fonts', 'html', 'fetch-newest-analytics'],
    'vulcanize',
    ['clean-dist', 'minify-dist'],
    'cache-config',
    cb);
});

// Deploy Tasks
// ------------

// Pre-deploy tasks
gulp.task('pre-deploy', function(cb) {
  runSequence(
    'default',
    'fix-path-sw-toolbox',
    'revision',
    cb);
});

// Deploy to development environment
gulp.task('deploy:dev', ['pre-deploy'],
  require(taskDir + 'deploy')($, config, gulp, 'development'));

// Deploy to staging environment
gulp.task('deploy:stag', ['pre-deploy'],
  require(taskDir + 'deploy')($, config, gulp, 'staging'));

// Deploy to production environment
gulp.task('deploy:prod', ['pre-deploy'],
  require(taskDir + 'deploy')($, config, gulp, 'production'));

// Promote the staging version to the production environment
gulp.task('deploy:promote',
  require(taskDir + 'deploy')($, config, gulp, 'promote'));

// Tool Tasks
// ----------

// Run PageSpeed Insights
gulp.task('pagespeed', require(taskDir + 'pagespeed')(config));

// Test Tasks
// ----------

// Load tasks for web-component-tester
// Adds tasks for `gulp test:local` and `gulp test:remote`
require('web-component-tester').gulp.init(gulp);

// Load custom tasks from the `tasks` directory
try { require('require-dir')('tasks'); } catch (err) {}
