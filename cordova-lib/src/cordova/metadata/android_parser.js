/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var fs            = require('fs'),
    path          = require('path'),
    et            = require('elementtree'),
    xml           = require('cordova-common').xmlHelpers,
    util          = require('../util'),
    events        = require('cordova-common').events,
    shell         = require('shelljs'),
    Q             = require('q'),
    Parser        = require('./parser'),
    ConfigParser = require('cordova-common').ConfigParser,
    CordovaError = require('cordova-common').CordovaError;


function android_parser(project) {
    if (!fs.existsSync(path.join(project, 'build.gradle'))) {
        throw new CordovaError('The provided path "' + project + '" is not an Android project.');
    }

    // Call the base class constructor
    Parser.call(this, 'android', project);

    this.path = project;

    //If we have a gradle file but not a manifest, this is an Android Studio project
    if(!fs.existsSync(path.join(project, 'AndroidManifest.xml'))) {
      this.path = path.join(project, 'app', 'src', 'main');
    }

    this.strings = path.join(this.path, 'res', 'values', 'strings.xml');
    this.manifest = path.join(this.path, 'AndroidManifest.xml');
    this.android_config = path.join(this.path, 'res', 'xml', 'config.xml');
}

require('util').inherits(android_parser, Parser);

module.exports = android_parser;

android_parser.prototype.findAndroidLaunchModePreference = function(config) {
    var launchMode = config.getPreference('AndroidLaunchMode');
    if (!launchMode) {
        // Return a default value
        return 'singleTop';
    }

    var expectedValues = ['standard', 'singleTop', 'singleTask', 'singleInstance'];
    var valid = expectedValues.indexOf(launchMode) !== -1;
    if (!valid) {
        events.emit('warn', 'Unrecognized value for AndroidLaunchMode preference: ' + launchMode);
        events.emit('warn', '  Expected values are: ' + expectedValues.join(', '));
        // Note: warn, but leave the launch mode as developer wanted, in case the list of options changes in the future
    }

    return launchMode;
};

// remove the default resource name from all drawable folders
// return the array of the densities in this project
android_parser.prototype.deleteDefaultResource = function(name) {
    var res = path.join(this.path, 'res');
    var dirs = fs.readdirSync(res);

    for (var i=0; i<dirs.length; i++) {
        var filename = dirs[i];
        if (filename.indexOf('drawable-') === 0) {
            var imgPath = path.join(res, filename, name);
            if (fs.existsSync(imgPath)) {
                shell.chmod('u+w', imgPath);
                fs.unlinkSync(imgPath);
                events.emit('verbose', 'deleted: ' + imgPath);
            }
            imgPath = imgPath.replace(/\.png$/, '.9.png');
            if (fs.existsSync(imgPath)) {
                shell.chmod('u+w', imgPath);
                fs.unlinkSync(imgPath);
                events.emit('verbose', 'deleted: ' + imgPath);
            }
        }
    }
};

android_parser.prototype.copyImage = function(src, density, name) {
    var destFolder = path.join(this.path, 'res', (density ? 'drawable-': 'drawable') + density);
    var isNinePatch = !!/\.9\.png$/.exec(src);
    var ninePatchName = name.replace(/\.png$/, '.9.png');

    // default template does not have default asset for this density
    if (!fs.existsSync(destFolder)) {
        fs.mkdirSync(destFolder);
    }

    var destFilePath = path.join(destFolder, isNinePatch ? ninePatchName : name);
    events.emit('verbose', 'copying image from ' + src + ' to ' + destFilePath);
    shell.cp('-f', src, destFilePath);
};

android_parser.prototype.handleSplashes = function(config) {
    var resources = config.getSplashScreens('android');
    var me = this;
    // if there are "splash" elements in config.xml
    if (resources.length > 0) {
        this.deleteDefaultResource('screen.png');
        events.emit('verbose', 'splash screens: ' + JSON.stringify(resources));

        var projectRoot = util.isCordova(this.path);

        var hadMdpi = false;
        resources.forEach(function (resource) {
            if (!resource.density) {
                return;
            }
            if (resource.density == 'mdpi') {
                hadMdpi = true;
            }
            me.copyImage(path.join(projectRoot, resource.src), resource.density, 'screen.png');
        });
        // There's no "default" drawable, so assume default == mdpi.
        if (!hadMdpi && resources.defaultResource) {
            me.copyImage(path.join(projectRoot, resources.defaultResource.src), 'mdpi', 'screen.png');
        }
    }
};

android_parser.prototype.handleIcons = function(config) {
    var icons = config.getIcons('android');

    // if there are icon elements in config.xml
    if (icons.length === 0) {
        events.emit('verbose', 'This app does not have launcher icons defined');
        return;
    }

    this.deleteDefaultResource('icon.png');

    var android_icons = {};
    var default_icon;
    // http://developer.android.com/design/style/iconography.html
    var sizeToDensityMap = {
        36: 'ldpi',
        48: 'mdpi',
        72: 'hdpi',
        96: 'xhdpi',
        144: 'xxhdpi',
        192: 'xxxhdpi'
    };
    // find the best matching icon for a given density or size
    // @output android_icons
    var parseIcon = function(icon, icon_size) {
        // do I have a platform icon for that density already
        var density = icon.density || sizeToDensityMap[icon_size];
        if (!density) {
            // invalid icon defition ( or unsupported size)
            return;
        }
        var previous = android_icons[density];
        if (previous && previous.platform) {
            return;
        }
        android_icons[density] = icon;
    };

    // iterate over all icon elements to find the default icon and call parseIcon
    for (var i=0; i<icons.length; i++) {
        var icon = icons[i];
        var size = icon.width;
        if (!size) {
            size = icon.height;
        }
        if (!size && !icon.density) {
            if (default_icon) {
                events.emit('verbose', 'more than one default icon: ' + JSON.stringify(icon));
            } else {
                default_icon = icon;
            }
        } else {
            parseIcon(icon, size);
        }
    }
    var projectRoot = util.isCordova(this.path);
    for (var density in android_icons) {
        this.copyImage(path.join(projectRoot, android_icons[density].src), density, 'icon.png');
    }
    // There's no "default" drawable, so assume default == mdpi.
    if (default_icon && !android_icons.mdpi) {
        this.copyImage(path.join(projectRoot, default_icon.src), 'mdpi', 'icon.png');
    }
};

android_parser.prototype.update_from_config = function(config) {
    // TODO: share code for this func with Android. Or fix it and remove
    // the below JSHint hacks line.
    // jshint unused:false, indent:false, undef:true, loopfunc:true, shadow:true, quotmark:false
    if (config instanceof ConfigParser) {
    } else throw new Error('update_from_config requires a ConfigParser object');

    // Update app name by editing res/values/strings.xml
    var name = config.name();
    var strings = xml.parseElementtreeSync(this.strings);
    strings.find('string[@name="app_name"]').text = name;
    fs.writeFileSync(this.strings, strings.write({indent: 4}), 'utf-8');
    events.emit('verbose', 'Wrote out Android application name to "' + name + '"');

    this.handleSplashes(config);
    this.handleIcons(config);

    var manifest = xml.parseElementtreeSync(this.manifest);
    // Update the version by changing the AndroidManifest android:versionName
    var version = config.version();
    var versionCode = config.android_versionCode() || default_versionCode(version);
    manifest.getroot().attrib["android:versionName"] = version;
    manifest.getroot().attrib["android:versionCode"] = versionCode;

    // Update package name by changing the AndroidManifest id and moving the entry class around to the proper package directory
    var pkg = config.android_packageName() || config.packageName();
    pkg = pkg.replace(/-/g, '_'); // Java packages cannot support dashes
    var orig_pkg = manifest.getroot().attrib.package;
    manifest.getroot().attrib.package = pkg;

    var act = manifest.getroot().find('./application/activity');

    // Set the android:screenOrientation in the AndroidManifest
    var orientation = this.helper.getOrientation(config);

    if (orientation && !this.helper.isDefaultOrientation(orientation)) {
        act.attrib['android:screenOrientation'] = orientation;
    } else {
        delete act.attrib['android:screenOrientation'];
    }

    // Set android:launchMode in AndroidManifest
    var androidLaunchModePref = this.findAndroidLaunchModePreference(config);
    if (androidLaunchModePref) {
        act.attrib["android:launchMode"] = androidLaunchModePref;
    } else { // User has (explicitly) set an invalid value for AndroidLaunchMode preference
        delete act.attrib["android:launchMode"]; // use Android default value (standard)
    }

    // Set min/max/target SDK version
    //<uses-sdk android:minSdkVersion="10" android:targetSdkVersion="19" ... />
    var usesSdk = manifest.getroot().find('./uses-sdk');
    ['minSdkVersion', 'maxSdkVersion', 'targetSdkVersion'].forEach(function(sdkPrefName) {
        var sdkPrefValue = config.getPreference('android-' + sdkPrefName, 'android');
        if (!sdkPrefValue) return;

        if (!usesSdk) { // if there is no required uses-sdk element, we should create it first
            usesSdk = new et.Element('uses-sdk');
            manifest.getroot().append(usesSdk);
        }
        usesSdk.attrib['android:' + sdkPrefName] = sdkPrefValue;
    });

    // Write out AndroidManifest.xml
    fs.writeFileSync(this.manifest, manifest.write({indent: 4}), 'utf-8');

    var orig_pkgDir = path.join(this.path, 'src', path.join.apply(null, orig_pkg.split('.')));
    var java_files = fs.readdirSync(orig_pkgDir).filter(function(f) {
      return f.indexOf('.svn') == -1 && f.indexOf('.java') >= 0 && fs.readFileSync(path.join(orig_pkgDir, f), 'utf-8').match(/extends\s+CordovaActivity/);
    });
    if (java_files.length === 0) {
      throw new Error('No Java files found which extend CordovaActivity.');
    } else if(java_files.length > 1) {
      events.emit('log', 'Multiple candidate Java files (.java files which extend CordovaActivity) found. Guessing at the first one, ' + java_files[0]);
    }

    var orig_java_class = java_files[0];
    var pkgDir = path.join(this.path, 'src', path.join.apply(null, pkg.split('.')));
    shell.mkdir('-p', pkgDir);
    var orig_javs = path.join(orig_pkgDir, orig_java_class);
    var new_javs = path.join(pkgDir, orig_java_class);
    var javs_contents = fs.readFileSync(orig_javs, 'utf-8');
    javs_contents = javs_contents.replace(/package [\w\.]*;/, 'package ' + pkg + ';');
    events.emit('verbose', 'Wrote out Android package name to "' + pkg + '"');
    fs.writeFileSync(new_javs, javs_contents, 'utf-8');
    // remove the original if different from the new.
    if(orig_pkgDir !== pkgDir){
      shell.rm('-Rf',orig_javs);
      // remove any empty directories
      var curDir = path.dirname(orig_javs);
      while(curDir !== path.resolve(this.path, 'src')) {
          if(fs.existsSync(curDir) && fs.readdirSync(curDir).length === 0) {
              fs.rmdirSync(curDir);
              curDir = path.resolve(curDir, '..');
            } else {
              break;
            }
          }
    }
};

// Returns the platform-specific www directory.
android_parser.prototype.www_dir = function() {
    return path.join(this.path, 'assets', 'www');
};

android_parser.prototype.config_xml = function(){
    return this.android_config;
};

// Used for creating platform_www in projects created by older versions.
android_parser.prototype.cordovajs_path = function(libDir) {
    var jsPath = path.join(libDir, 'framework', 'assets', 'www', 'cordova.js');
    return path.resolve(jsPath);
};

android_parser.prototype.cordovajs_src_path = function(libDir) {
    var jsPath = path.join(libDir, 'cordova-js-src');
    return path.resolve(jsPath);
};

// Replace the www dir with contents of platform_www and app www.
android_parser.prototype.update_www = function() {
    var projectRoot = util.isCordova(this.path);
    var app_www = util.projectWww(projectRoot);
    var platform_www = path.join(this.path, 'platform_www');

    // Clear the www dir
    shell.rm('-rf', this.www_dir());
    shell.mkdir(this.www_dir());
    // Copy over all app www assets
    shell.cp('-rf', path.join(app_www, '*'), this.www_dir());
    // Copy over stock platform www assets (cordova.js)
    shell.cp('-rf', path.join(platform_www, '*'), this.www_dir());
};

// update the overrides folder into the www folder
android_parser.prototype.update_overrides = function() {
    var projectRoot = util.isCordova(this.path);
    var merges_path = path.join(util.appDir(projectRoot), 'merges', 'android');
    if (fs.existsSync(merges_path)) {
        var overrides = path.join(merges_path, '*');
        shell.cp('-rf', overrides, this.www_dir());
    }
};

// Returns a promise.
android_parser.prototype.update_project = function(cfg) {
    var platformWww = path.join(this.path, 'assets');
    try {
        this.update_from_config(cfg);
        this.update_overrides();
    } catch(e) {
        return Q.reject(e);
    }
    // delete any .svn folders copied over
    util.deleteSvnFolders(platformWww);
    return Q();
};

// Consturct the default value for versionCode as
// PATCH + MINOR * 100 + MAJOR * 10000
// see http://developer.android.com/tools/publishing/versioning.html
function default_versionCode(version) {
    var nums = version.split('-')[0].split('.');
    var versionCode = 0;
    if (+nums[0]) {
        versionCode += +nums[0] * 10000;
    }
    if (+nums[1]) {
        versionCode += +nums[1] * 100;
    }
    if (+nums[2]) {
        versionCode += +nums[2];
    }
    return versionCode;
}
