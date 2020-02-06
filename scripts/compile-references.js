/********************************************************************************
 * Copyright (C) 2020 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
'use-strict';

/**
 * This script generates tsconfig references between our workspaces, it also
 * configures our .eslintrc file to use such references.
 *
 * `tsc` build mode relies on these references to build out of date dependencies
 * only when required, but it cannot infer workspaces by itself, it has to be
 * explicitly defined [1].
 *
 * This script exits with a code different from zero if something needed to be
 * updated.
 *
 * You can do a dry run using the cli flag `--dry-run`.
 *
 * [1]: https://www.typescriptlang.org/docs/handbook/project-references.html
 */

// @ts-check

const cp = require('child_process');
const path = require('path').posix;
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const DRY_RUN = popFlag(process.argv, '--dry-run');

const FORCE_REWRITE = popFlag(process.argv, '--force-rewrite');

/** @type {{ [packageName: string]: YarnWorkspace }} */
const YARN_WORKSPACES = JSON.parse(cp.execSync('yarn --silent workspaces info').toString());

// Add the package name inside each package object.
for (const [packageName, yarnWorkspace] of Object.entries(YARN_WORKSPACES)) {
    yarnWorkspace.name = packageName;
}

/** @type {YarnWorkspace} */
const THEIA_MONOREPO = {
    name: '@theia/monorepo',
    workspaceDependencies: Object.keys(YARN_WORKSPACES),
    location: ROOT,
};

{
    let rewriteRequired = false;

    // Configure all `compile.tsconfig.json` files of this monorepo
    for (const packageName of Object.keys(YARN_WORKSPACES)) {
        const workspacePackage = YARN_WORKSPACES[packageName];
        const tsconfigCompilePath = path.join(ROOT, workspacePackage.location, 'compile.tsconfig.json');
        const references = getTypescriptReferences(workspacePackage);
        rewriteRequired |= configureTypeScriptCompilation(workspacePackage, tsconfigCompilePath, references);
    }

    // Configure our root compilation configuration, living inside `configs/root-compilation.tsconfig.json`.
    const configsFolder = path.join(ROOT, 'configs');
    const tsconfigCompilePath = path.join(configsFolder, 'root-compilation.tsconfig.json');
    const references = getTypescriptReferences(THEIA_MONOREPO, configsFolder);
    rewriteRequired |= configureTypeScriptCompilation(THEIA_MONOREPO, tsconfigCompilePath, references);

    // Configure the root `tsconfig.json` for code navigation using `tsserver`.
    const tsconfigNavPath = path.join(ROOT, 'tsconfig.json');
    rewriteRequired |= configureTypeScriptNavigation(THEIA_MONOREPO, tsconfigNavPath);

    // CI will be able to tell if references got changed by looking at the exit code.
    if (rewriteRequired) {
        if (DRY_RUN) {
            // Running a dry run usually only happens when a developer or CI runs the tests, so we only print the help then.
            console.error('TypeScript references seem to be out of sync, run "yarn update:references" to fix.');
        }
        process.exitCode = 1;
    }
}

/**
 * @param {YarnWorkspace} requestedPackage
 * @param {string} [overrideLocation] affects how relative paths are computed.
 * @returns {string[]} project references for `requestedPackage`.
 */
function getTypescriptReferences(requestedPackage, overrideLocation) {
    const references = [];
    for (const dependency of requestedPackage.workspaceDependencies || []) {
        const depWorkspace = YARN_WORKSPACES[dependency];
        const depConfig = path.join(depWorkspace.location, 'compile.tsconfig.json');
        if (!fs.existsSync(depConfig)) {
            continue;
        }
        const relativePath = path.relative(overrideLocation || requestedPackage.location, depWorkspace.location);
        references.push(relativePath);
    }
    return references;
}

/**
 * Wires a given compilation tsconfig file according to the provided references.
 * This allows TypeScript to operate in build mode.
 *
 * @param {YarnWorkspace} targetPackage for debug purpose.
 * @param {string} tsconfigPath path to the tsconfig file to edit.
 * @param {string[]} references list of paths to the related project roots.
 * @returns {boolean} rewrite was needed.
 */
function configureTypeScriptCompilation(targetPackage, tsconfigPath, references) {
    if (!fs.existsSync(tsconfigPath)) {
        return;
    }
    let needRewrite = false;
    const tsconfigJson = readJsonFile(tsconfigPath);
    if (!tsconfigJson.compilerOptions) {
        // Somehow no `compilerOptions` literal is defined.
        tsconfigJson.compilerOptions = {
            composite: true,
            rootDir: 'src',
            outDir: 'lib',
        };
    } else if (!tsconfigJson.compilerOptions.composite) {
        // `compilerOptions` is missing the `composite` literal.
        tsconfigJson.compilerOptions = {
            composite: true,
            ...tsconfigJson.compilerOptions,
        };
        needRewrite = true;
    }
    const currentReferences = new Set(
        (tsconfigJson['references'] || [])
            // We will work on a set of paths, easier to handle than objects.
            .map(reference => reference.path)
            // Remove any invalid reference (maybe outdated).
            .filter(referenceRelativePath => {
                const referencePath = path.join(path.dirname(tsconfigPath), referenceRelativePath);
                try {
                    const referenceStat = fs.statSync(referencePath);
                    const isValid = referenceStat.isDirectory() && fs.statSync(path.join(referencePath, 'tsconfig.json')).isFile()
                        || referenceStat.isFile(); // still could be something else than a tsconfig, but good enough.

                    if (!isValid) {
                        needRewrite = true;
                    }
                    return isValid; // keep or not

                } catch {
                    console.error(`${targetPackage.name} invalid typescript reference: ${referencePath}`);
                    needRewrite = true;
                    return false; // remove
                }
            })
    );
    for (const reference of references) {
        const tsconfigReference = path.join(reference, 'compile.tsconfig.json');
        if (!currentReferences.has(tsconfigReference)) {
            currentReferences.add(tsconfigReference);
            needRewrite = true;
        }
    }
    if (!DRY_RUN && (FORCE_REWRITE || needRewrite)) {
        tsconfigJson.references = [];
        for (const reference of currentReferences) {
            tsconfigJson.references.push({
                path: reference,
            });
        }
        const content = JSON.stringify(tsconfigJson, undefined, 2);
        fs.writeFileSync(tsconfigPath, content + '\n');
    }
    return needRewrite;
}

/**
 * Wire the root `tsconfig.json` to map scoped import to real location in the monorepo.
 * This setup is a shim for the TypeScript language server to provide cross-package navigation.
 * Compilation is done via `compile.tsconfig.json` files.
 *
 * @param {YarnWorkspace} targetPackage for debug purpose.
 * @param {string} tsconfigPath
 * @returns {boolean} rewrite was needed.
 */
function configureTypeScriptNavigation(targetPackage, tsconfigPath) {
    let needRewrite = false;
    const tsconfigJson = readJsonFile(tsconfigPath);
    if (typeof tsconfigJson.compilerOptions === 'undefined') {
        // Somehow no `compilerOptions` literal is defined.
        tsconfigJson.compilerOptions = {
            baseUrl: '.',
            paths: {},
        };
        needRewrite = true;
    } else if (typeof tsconfigJson.compilerOptions.paths === 'undefined') {
        // `compilerOptions` is missing the `paths` literal.
        tsconfigJson.compilerOptions = {
            ...tsconfigJson.compilerOptions,
            paths: {},
        };
        needRewrite = true;
    }
    /** @type {{ [prefix: string]: string[] }} */
    const currentPaths = tsconfigJson.compilerOptions.paths;
    for (const packageName of THEIA_MONOREPO.workspaceDependencies) {
        const depWorkspace = YARN_WORKSPACES[packageName];

        /** @type {string} */
        let originalImportPath;
        /** @type {string} */
        let mappedFsPath;

        const depSrcPath = path.join(depWorkspace.location, 'src');
        const depConfigPath = path.join(depWorkspace.location, 'compile.tsconfig.json');
        if (fs.existsSync(depConfigPath) && fs.existsSync(depSrcPath)) {
            // If it is a TypeScript dependency, map `lib` imports to our local sources in `src`.
            const depConfigJson = readJsonFile(depConfigPath);
            originalImportPath = `${packageName}/${depConfigJson.compilerOptions.outDir}/*`;
            mappedFsPath = path.relative(THEIA_MONOREPO.location, path.join(depSrcPath, '*'));
        } else {
            // I don't really know what to do here, simply point to our local package root.
            originalImportPath = `${packageName}/*`;
            mappedFsPath = path.relative(THEIA_MONOREPO.location, path.join(depWorkspace.location, '*'));
        }

        if (typeof currentPaths[originalImportPath] === 'undefined' || currentPaths[originalImportPath][0] !== mappedFsPath) {
            currentPaths[originalImportPath] = [mappedFsPath];
            needRewrite = true;
        }
    }
    if (!DRY_RUN && (FORCE_REWRITE || needRewrite)) {
        const content = JSON.stringify(tsconfigJson, undefined, 2);
        fs.writeFileSync(tsconfigPath, content + '\n');
        console.warn(`Updated references for ${targetPackage.name}.`);
    }
    return needRewrite;
}

/**
 *
 * @param {string[]} argv
 * @param {string} flag
 * @returns {boolean}
 */
function popFlag(argv, flag) {
    const flagIndex = argv.indexOf(flag)
    if (flagIndex !== -1) {
        argv.splice(flagIndex, 1);
        return true;
    } else {
        return false;
    }
}

/**
 * @param {string} filePath
 * @returns {any}
 */
function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath).toString());
    } catch (error) {
        console.error('ParseError in file:', filePath);
        throw error;
    }
}

/**
 * @typedef YarnWorkspace
 * @property {string} name
 * @property {string} location
 * @property {string[]} workspaceDependencies
 */
