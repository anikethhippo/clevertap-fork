/*
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

var fs = require('fs-extra');
var path = require('path');
const execa = require('execa');
var events = require('cordova-common').events;
var CordovaError = require('cordova-common').CordovaError;
var check_reqs = require('../check_reqs');
var PackageType = require('../PackageType');
const { createEditor } = require('properties-parser');

const MARKER = 'YOUR CHANGES WILL BE ERASED!';
const SIGNING_PROPERTIES = '-signing.properties';
const TEMPLATE =
    '# This file is automatically generated.\n' +
    '# Do not modify this file -- ' + MARKER + '\n';

const archSpecificRegex = /-x86|-arm/;
const unsignedBuildRegex = /-unsigned/;

const fileSorter = (filePathA, filePathB) => {
    const archSpecificA = archSpecificRegex.test(filePathA);
    const archSpecificB = archSpecificRegex.test(filePathB);

    // If they are not equal, then sort by specific archs after generic ones
    if (archSpecificA !== archSpecificB) {
        return archSpecificA < archSpecificB ? -1 : 1;
    }

    // Otherwise, move onto the next sort item, which is by sorting unsigned bulds after signed ones
    const unsignedA = unsignedBuildRegex.test(filePathA);
    const unsignedB = unsignedBuildRegex.test(filePathB);

    if (unsignedA !== unsignedB) {
        return unsignedA < unsignedB ? -1 : 1;
    }

    // Then, sort by modification time, latest first
    const modTimeA = fs.statSync(filePathA).mtime.getTime();
    const modTimeB = fs.statSync(filePathB).mtime.getTime();

    if (modTimeA !== modTimeB) {
        return modTimeA < modTimeB ? 1 : -1;
    }

    // Finally, if all above is the same, sort by file name length, ascending
    return filePathB.length < filePathA.length ? -1 : 1;
};

/**
 * If the provided directory does not exist or extension is missing, return an empty array.
 * If the director exists, loop the directories and collect list of files matching the extension.
 *
 * @param {String} dir Directory to scan
 * @param {String} extension
 */
function recursivelyFindFiles (dir, extension) {
    if (!fs.existsSync(dir) || !extension) return [];

    const files = fs.readdirSync(dir, { withFileTypes: true })
        .map(entry => {
            const item = path.resolve(dir, entry.name);

            if (entry.isDirectory()) return recursivelyFindFiles(item, extension);
            if (path.extname(entry.name) === `.${extension}`) return item;
            return false;
        });

    return Array.prototype.concat(...files)
        .filter(file => file !== false);
}

/**
 * @param {String} dir
 * @param {String} build_type
 * @param {String} arch
 * @param {String} extension
 */
function findOutputFilesHelper (dir, build_type, arch, extension) {
    let files = recursivelyFindFiles(path.resolve(dir, build_type), extension);

    if (files.length === 0) return files;

    // Assume arch-specific build if newest apk has -x86 or -arm.
    const archSpecific = !!/-x86|-arm/.exec(path.basename(files[0]));

    // And show only arch-specific ones (or non-arch-specific)
    files = files.filter(p => !!/-x86|-arm/.exec(path.basename(p)) === archSpecific);

    if (archSpecific && files.length > 1 && arch) {
        files = files.filter(p => path.basename(p).indexOf('-' + arch) !== -1);
    }

    return files;
}

class ProjectBuilder {
    constructor (rootDirectory) {
        this.root = rootDirectory || path.resolve(__dirname, '../../..');
        this.apkDir = path.join(this.root, 'app', 'build', 'outputs', 'apk');
        this.aabDir = path.join(this.root, 'app', 'build', 'outputs', 'bundle');
    }

    getArgs (cmd, opts) {
        let args;
        let buildCmd = cmd;
        if (opts.packageType === PackageType.BUNDLE) {
            if (cmd === 'release') {
                buildCmd = ':app:bundleRelease';
            } else if (cmd === 'debug') {
                buildCmd = ':app:bundleDebug';
            }

            args = [buildCmd, '-b', path.join(this.root, 'build.gradle')];
        } else {
            if (cmd === 'release') {
                buildCmd = 'cdvBuildRelease';
            } else if (cmd === 'debug') {
                buildCmd = 'cdvBuildDebug';
            }

            args = [buildCmd, '-b', path.join(this.root, 'build.gradle')];

            if (opts.arch) {
                args.push('-PcdvBuildArch=' + opts.arch);
            }
        }

        args.push.apply(args, opts.extraArgs);

        return args;
    }

    /*
    * This returns a promise
    */
    runGradleWrapper (gradle_cmd) {
        var gradlePath = path.join(this.root, 'gradlew');
        var wrapperGradle = path.join(this.root, 'wrapper.gradle');
        if (fs.existsSync(gradlePath)) {
            // Literally do nothing, for some reason this works, while !fs.existsSync didn't on Windows
        } else {
            return execa(gradle_cmd, ['-p', this.root, 'wrapper', '-b', wrapperGradle], { stdio: 'inherit' });
        }
    }

    readProjectProperties () {
        function findAllUniq (data, r) {
            var s = {};
            var m;
            while ((m = r.exec(data))) {
                s[m[1]] = 1;
            }
            return Object.keys(s);
        }

        var data = fs.readFileSync(path.join(this.root, 'project.properties'), 'utf8');
        return {
            libs: findAllUniq(data, /^\s*android\.library\.reference\.\d+=(.*)(?:\s|$)/mg),
            gradleIncludes: findAllUniq(data, /^\s*cordova\.gradle\.include\.\d+=(.*)(?:\s|$)/mg),
            systemLibs: findAllUniq(data, /^\s*cordova\.system\.library\.\d+=(.*)(?:\s|$)/mg)
        };
    }

    extractRealProjectNameFromManifest () {
        var manifestPath = path.join(this.root, 'app', 'src', 'main', 'AndroidManifest.xml');
        var manifestData = fs.readFileSync(manifestPath, 'utf8');
        var m = /<manifest[\s\S]*?package\s*=\s*"(.*?)"/i.exec(manifestData);
        if (!m) {
            throw new CordovaError('Could not find package name in ' + manifestPath);
        }

        var packageName = m[1];
        var lastDotIndex = packageName.lastIndexOf('.');
        return packageName.substring(lastDotIndex + 1);
    }

    // Makes the project buildable, minus the gradle wrapper.
    prepBuildFiles () {
        // Update the version of build.gradle in each dependent library.
        var pluginBuildGradle = path.join(this.root, 'cordova', 'lib', 'plugin-build.gradle');
        var propertiesObj = this.readProjectProperties();
        var subProjects = propertiesObj.libs;

        // Check and copy the gradle file into the subproject
        // Called by the loop before this function def

        var checkAndCopy = function (subProject, root) {
            var subProjectGradle = path.join(root, subProject, 'build.gradle');
            // This is the future-proof way of checking if a file exists
            // This must be synchronous to satisfy a Travis test
            try {
                fs.accessSync(subProjectGradle, fs.F_OK);
            } catch (e) {
                fs.copySync(pluginBuildGradle, subProjectGradle);
            }
        };

        for (var i = 0; i < subProjects.length; ++i) {
            if (subProjects[i] !== 'CordovaLib') {
                checkAndCopy(subProjects[i], this.root);
            }
        }
        var name = this.extractRealProjectNameFromManifest();
        // Remove the proj.id/name- prefix from projects: https://issues.apache.org/jira/browse/CB-9149
        var settingsGradlePaths = subProjects.map(function (p) {
            var realDir = p.replace(/[/\\]/g, ':');
            var libName = realDir.replace(name + '-', '');
            var str = 'include ":' + libName + '"\n';
            if (realDir.indexOf(name + '-') !== -1) {
                str += 'project(":' + libName + '").projectDir = new File("' + p + '")\n';
            }
            return str;
        });

        fs.writeFileSync(path.join(this.root, 'settings.gradle'),
            '// GENERATED FILE - DO NOT EDIT\n' +
            'include ":"\n' + settingsGradlePaths.join(''));

        // Update dependencies within build.gradle.
        var buildGradle = fs.readFileSync(path.join(this.root, 'app', 'build.gradle'), 'utf8');
        var depsList = '';
        var root = this.root;
        var insertExclude = function (p) {
            var gradlePath = path.join(root, p, 'build.gradle');
            var projectGradleFile = fs.readFileSync(gradlePath, 'utf-8');
            if (projectGradleFile.indexOf('CordovaLib') !== -1) {
                depsList += '{\n        exclude module:("CordovaLib")\n    }\n';
            } else {
                depsList += '\n';
            }
        };
        subProjects.forEach(function (p) {
            events.emit('log', 'Subproject Path: ' + p);
            var libName = p.replace(/[/\\]/g, ':').replace(name + '-', '');
            if (libName !== 'app') {
                depsList += '    implementation(project(path: ":' + libName + '"))';
                insertExclude(p);
            }
        });
        // For why we do this mapping: https://issues.apache.org/jira/browse/CB-8390
        var SYSTEM_LIBRARY_MAPPINGS = [
            [/^\/?extras\/android\/support\/(.*)$/, 'com.android.support:support-$1:+'],
            [/^\/?google\/google_play_services\/libproject\/google-play-services_lib\/?$/, 'com.google.android.gms:play-services:+']
        ];

        propertiesObj.systemLibs.forEach(function (p) {
            var mavenRef;
            // It's already in gradle form if it has two ':'s
            if (/:.*:/.exec(p)) {
                mavenRef = p;
            } else {
                for (var i = 0; i < SYSTEM_LIBRARY_MAPPINGS.length; ++i) {
                    var pair = SYSTEM_LIBRARY_MAPPINGS[i];
                    if (pair[0].exec(p)) {
                        mavenRef = p.replace(pair[0], pair[1]);
                        break;
                    }
                }
                if (!mavenRef) {
                    throw new CordovaError('Unsupported system library (does not work with gradle): ' + p);
                }
            }
            depsList += '    implementation "' + mavenRef + '"\n';
        });

        buildGradle = buildGradle.replace(/(SUB-PROJECT DEPENDENCIES START)[\s\S]*(\/\/ SUB-PROJECT DEPENDENCIES END)/, '$1\n' + depsList + '    $2');
        var includeList = '';

        propertiesObj.gradleIncludes.forEach(function (includePath) {
            includeList += 'apply from: "../' + includePath + '"\n';
        });
        buildGradle = buildGradle.replace(/(PLUGIN GRADLE EXTENSIONS START)[\s\S]*(\/\/ PLUGIN GRADLE EXTENSIONS END)/, '$1\n' + includeList + '$2');
        // This needs to be stored in the app gradle, not the root grade
        fs.writeFileSync(path.join(this.root, 'app', 'build.gradle'), buildGradle);
    }

    prepEnv (opts) {
        var self = this;
        return check_reqs.check_gradle()
            .then(function (gradlePath) {
                return self.runGradleWrapper(gradlePath);
            }).then(function () {
                return self.prepBuildFiles();
            }).then(() => {
                // update/set the distributionUrl in the gradle-wrapper.properties
                const gradleWrapperPropertiesPath = path.join(self.root, 'gradle/wrapper/gradle-wrapper.properties');
                const gradleWrapperProperties = createEditor(gradleWrapperPropertiesPath);
                const distributionUrl = process.env.CORDOVA_ANDROID_GRADLE_DISTRIBUTION_URL || 'https://services.gradle.org/distributions/gradle-6.5-all.zip';
                gradleWrapperProperties.set('distributionUrl', distributionUrl);
                gradleWrapperProperties.save();

                events.emit('verbose', `Gradle Distribution URL: ${distributionUrl}`);
            })
            .then(() => {
                const signingPropertiesPath = path.join(self.root, `${opts.buildType}${SIGNING_PROPERTIES}`);

                if (fs.existsSync(signingPropertiesPath)) fs.removeSync(signingPropertiesPath);
                if (opts.packageInfo) {
                    fs.ensureFileSync(signingPropertiesPath);
                    const signingProperties = createEditor(signingPropertiesPath);
                    signingProperties.addHeadComment(TEMPLATE);
                    opts.packageInfo.appendToProperties(signingProperties);
                }
            });
    }

    /*
    * Builds the project with gradle.
    * Returns a promise.
    */
    build (opts) {
        var wrapper = path.join(this.root, 'gradlew');
        var args = this.getArgs(opts.buildType === 'debug' ? 'debug' : 'release', opts);

        return execa(wrapper, args, { stdio: 'inherit' })
            .catch(function (error) {
                if (error.toString().indexOf('failed to find target with hash string') >= 0) {
                    return check_reqs.check_android_target(error).then(function () {
                        // If due to some odd reason - check_android_target succeeds
                        // we should still fail here.
                        throw error;
                    });
                }
                throw error;
            });
    }

    clean (opts) {
        const wrapper = path.join(this.root, 'gradlew');
        const args = this.getArgs('clean', opts);
        return execa(wrapper, args, { stdio: 'inherit' })
            .then(() => {
                fs.removeSync(path.join(this.root, 'out'));

                ['debug', 'release'].map(config => path.join(this.root, `${config}${SIGNING_PROPERTIES}`))
                    .forEach(file => {
                        const hasFile = fs.existsSync(file);
                        const hasMarker = hasFile && fs.readFileSync(file, 'utf8')
                            .includes(MARKER);

                        if (hasFile && hasMarker) fs.removeSync(file);
                    });
            });
    }

    findOutputApks (build_type, arch) {
        return findOutputFilesHelper(this.apkDir, build_type, arch, 'apk').sort(fileSorter);
    }

    findOutputBundles (build_type) {
        return findOutputFilesHelper(this.aabDir, build_type, false, 'aab').sort(fileSorter);
    }

    fetchBuildResults (build_type, arch) {
        return {
            apkPaths: this.findOutputApks(build_type, arch),
            buildType: build_type
        };
    }
}

module.exports = ProjectBuilder;