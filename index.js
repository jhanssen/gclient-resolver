const option = require("@jhanssen/options")("gclient-resolver");
const fs = require("fs");
const fsp = fs.promises;
const promisify = require("util").promisify;
const exec = promisify(require("child_process").exec);
const path = require("path");
const Parser = require("acorn").Parser;
const traverse = require("estraverse");

const gclientFile = option("gclient-file", ".gclient;standalone.gclient");
const gclientFiles = gclientFile.split(";");

const filterDir = option("filter-dir", "third_party");
const filterDirs = filterDir.split(";");

const noGitHub = option("no-github", "");
const noGitHubs = noGitHub.split(";");

function skipWhiteSpace(idx, skip, str) {
    if (idx === -1 || idx >= str.length)
        return -1;
    idx += skip;
    for (; idx < str.length; ++idx) {
        if (/\s/.test(str[idx]))
            continue;
        break;
    }
    if (idx === str.length)
        idx = -1;
    return idx;
}

function findMatching(idx, str) {
    if (idx === -1 || idx >= str.length)
        return -1;
    const possibilities = ["[]", "{}", "()"];
    let same = undefined;
    let find = undefined;
    for (const p of possibilities) {
        if (str[idx] === p[0]) {
            same = p[0];
            find = p[1];
        }
    }
    if (same === undefined || find === undefined) {
        console.error("invalid start character", str[idx]);
        return -1;
    }
    let insq = false;
    let indq = false;
    let esc = false;
    let found = 1;

    // skip to next char, continue from there
    ++idx;

    for (; idx < str.length; ++idx) {
        switch (str[idx]) {
        case '\\':
            if (insq || indq)
                esc = true;
            break;
        case '\'':
            if (esc) {
                esc = false;
            } else if (!indq) {
                insq = !insq;
            }
            break;
        case '"':
            if (esc) {
                esc = false;
            } else if (!insq) {
                indq = !indq;
            }
            break;
        case same:
            if (esc) {
                esc = false;
            } else if (!insq && !indq) {
                ++found;
            }
            break;
        case find:
            if (esc) {
                esc = false;
            } else if (!insq && !indq) {
                if (!--found) {
                    // found it
                    return idx;
                }
            }
            break;
        default:
            if (esc)
                esc = false;
            break;
        }
    }

    return -1;
}

function findInTree(needle, haystack) {
    // iterates all objects in needle, they need to have the equivalent values in haystack
    const objectEquals = (a, b) => {
        if (typeof a !== typeof b)
            return false;
        switch (typeof a) {
        case "string":
        case "number":
        case "boolean":
            return a === b;
        case "object":
            for (const k of Object.keys(a)) {
                if (!(k in b))
                    return false;
                if (!objectEquals(a[k], b[k]))
                    return false;
            }
            return true;
        default:
            console.error("unhandled object type", typeof a);
            return false;
        }
    };

    if (objectEquals(needle, haystack)) {
        return haystack;
    } else if (typeof haystack === "object") {
        for (const k of Object.keys(haystack)) {
            const f = findInTree(needle, haystack[k]);
            if (f !== undefined)
                return f;
        }
    }
    return undefined;
}

function parseGClientFile(data) {
    // find deps_file, should possibly consider the url as well?
    let solutions = skipWhiteSpace(data.indexOf("solutions"), 9, data);
    if (solutions === -1 || data[solutions] !== '=') {
        throw new Error("failed to get solutions (1)");
    }
    solutions = skipWhiteSpace(solutions, 1, data);
    if (solutions === -1 || data[solutions] !== '[') {
        throw new Error("failed to get solutions (2)");
    }
    const solutionsEnd = findMatching(solutions, data);
    if (solutionsEnd === -1 || data[solutionsEnd] !== ']') {
        throw new Error("failed to get solutions (3)");
    }
    const str = data.substr(solutions, solutionsEnd - solutions + 1);
    let obj;
    try {
        obj = Parser.parse(str, { ecmaVersion: 2020 });
    } finally {
        if (!obj) {
            throw new Error("failed to parse", str);
        }
        // console.log(JSON.stringify(obj, null, 4));
        const deps = findInTree({ key: { type: "Literal", value: "deps_file" } }, obj);
        if (deps === undefined) {
            throw new Error("unable to find deps_file");
        }
        try {
            return deps.value.value;
        } catch (e) {
            throw e;
        }
    }
    throw new Error("Unreachable (parseGClientFile)");
}

function parseObject(obj) {
    const ret = {};
    if (obj.type !== "ObjectExpression")
        throw new Error("Object not an ObjectExpression: " + obj.type);

    for (const p of obj.properties) {
        if (p.type !== "Property")
            throw new Error("Object property not a Property: " + p.type);
        if (p.key.type === "Literal") {
            // we only care about url here (I think)
            if (p.key.value === "url") {
                if (p.value.type === "Literal") {
                    ret[p.key.value] = p.value.value;
                } else {
                    throw new Error("Unknown prop value type\n" + JSON.stringify(p, null, 4));
                }
            }
        } else {
            throw new Error("Unknown prop key type\n" + JSON.stringify(p, null, 4));
        }
    }
    return ret;
}

function parseDepsVars(data) {
    let vars = skipWhiteSpace(data.indexOf("vars"), 4, data);
    if (vars === -1 || data[vars] !== '=') {
        throw new Error("failed to get vars (1)");
    }
    vars = skipWhiteSpace(vars, 1, data);
    if (vars === -1 || data[vars] !== '{') {
        throw new Error("failed to get vars (2)");
    }
    const varsEnd = findMatching(vars, data);
    if (varsEnd === -1 || data[varsEnd] !== '}') {
        throw new Error("failed to get vars (3)");
    }
    const str = "f = " + data.substr(vars, varsEnd - vars + 1);
    let obj;
    try {
        obj = Parser.parse(str, { ecmaVersion: 2020 });
    } catch (e) {
        console.log("failed to parse", e);
        throw e;
    }
    const depvars = findInTree({ type: "ObjectExpression" }, obj);
    if (depvars === undefined) {
        throw new Error("unable to find ObjectExpression (parseDepsVars)");
    }
    try {
        const varret = {};
        for (const d of depvars.properties) {
            if (d.key.type === "Literal") {
                switch (d.value.type) {
                case "Literal":
                    varret[d.key.value] = d.value.value;
                    break;
                case "Identifier":
                    // skip
                    break;
                case "ObjectExpression":
                    const nobj = parseObject(d.value);
                    if ("url" in nobj) {
                        varret[d.key.value] = nobj.url;
                    }
                    break;
                default:
                    throw new Error("Unknown value type\n" + JSON.stringify(d, null, 4));
                }
            } else {
                throw new Error("Unknown key type\n" + JSON.stringify(d, null, 4));
            }
        }
        return varret;
    } catch (e) {
        throw e;
    }
    throw new Error("Unreachable (parseDepsVars)");
}

function parseDepsDeps(data, vars) {
    let deps = skipWhiteSpace(data.indexOf("deps"), 4, data);
    if (deps === -1 || data[deps] !== '=') {
        throw new Error("failed to get deps (1)");
    }
    deps = skipWhiteSpace(deps, 1, data);
    if (deps === -1 || data[deps] !== '{') {
        throw new Error("failed to get deps (2)");
    }
    const depsEnd = findMatching(deps, data);
    if (depsEnd === -1 || data[depsEnd] !== '}') {
        throw new Error("failed to get deps (3)");
    }
    let str = "f = " + data.substr(deps, depsEnd - deps + 1);
    // replace # with //
    str = str.replace(/\s*#/g, "//");
    let obj;
    try {
        obj = Parser.parse(str, { ecmaVersion: 2020 });
    } catch (e) {
        console.log("failed to parse", e);
        throw e;
    }

    const fixupVar = node => {
        if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "Var") {
            if (node.arguments && node.arguments.length === 1) {
                if (node.arguments[0].type === "Literal") {
                    const varname = node.arguments[0].value;
                    if (!(varname in vars)) {
                        throw new Error("Unknown variable: " + varname);
                    }
                    return {
                        type: "Literal",
                        value: vars[varname]
                    };
                }
            }
        }
        return undefined;
    };

    // first, replace all Var('foo') with the var literal value
    obj = traverse.replace(obj, {
        enter(node) {
            if (node.type === "BinaryExpression" && node.operator === "+") {
                // console.log("enter", node);
                const replacedLeft = fixupVar(node.left);
                const replacedRight = fixupVar(node.right);
                if (replacedLeft || replacedRight) {
                    if (replacedLeft)
                        node.left = replacedLeft;
                    if (replacedRight)
                        node.right = replacedRight;
                    return node;
                }
            }
            return undefined;
        }
    });

    // second, replace 'BinaryExpression +' with a Literal containing the concatenated string value
    let replaced = false;
    do {
        replaced = false;
        obj = traverse.replace(obj, {
            enter(node) {
                if (node.type === "BinaryExpression" && node.operator === "+") {
                    if (node.left.type === "Literal" && node.right.type === "Literal") {
                        replaced = true;
                        return {
                            type: "Literal",
                            value: node.left.value + node.right.value
                        };
                    }
                }
                return undefined;
            }
        });
    } while (replaced);

    const depdeps = findInTree({ type: "ObjectExpression" }, obj);
    if (depdeps === undefined) {
        throw new Error("unable to find ObjectExpression (parseDepsDeps)");
    }
    try {
        const depret = {};
        for (const d of depdeps.properties) {
            if (d.key.type === "Literal") {
                switch (d.value.type) {
                case "Literal":
                    depret[d.key.value] = d.value.value;
                    break;
                case "Identifier":
                    // skip
                    break;
                case "ObjectExpression":
                    const nobj = parseObject(d.value);
                    if ("url" in nobj) {
                        depret[d.key.value] = nobj.url;
                    }
                    break;
                default:
                    throw new Error("Unknown value type\n" + JSON.stringify(d, null, 4));
                }
            } else {
                throw new Error("Unknown key type\n" + JSON.stringify(d, null, 4));
            }
        }

        // replace in-line vars
        for (const k of Object.keys(depret)) {
            let v = depret[k];
            let n = v.indexOf("{");
            while (n !== -1) {
                const nn = findMatching(n, v);
                if (nn !== -1) {
                    const vr = v.substr(n + 1, nn - n - 1);
                    if (vr in vars) {
                        v = v.replace(v.substr(n, nn - n + 1), vars[vr]);
                    }
                    n = v.indexOf("{", n);
                } else {
                    n = -1;
                }
            }
            depret[k] = v;
        }

        return depret;
    } catch (e) {
        throw e;
    }
    throw new Error("Unreachable (parseDepsDeps)");
}

function parseDepsFile(data) {
    // console.log("deps data", data);
    const vars = parseDepsVars(data);
    // console.log("got vars", vars);
    const deps = parseDepsDeps(data, vars);
    // console.log("got deps", deps);
    // replace silly chromium external urls with github urls
    for (const k of Object.keys(deps)) {
        let v = deps[k];
        let idx = v.indexOf("chromium.googlesource.com/external/github.com");
        if (idx !== -1) {
            // check if we want to prevent this replacement
            let shouldReplace = true;
            for (const ng of noGitHubs) {
                if (v.indexOf(ng) !== -1)
                    shouldReplace = false;
            }
            if (shouldReplace) {
                v = v.replace("chromium.googlesource.com/external/github.com", "github.com");
            }
        }
        // split url and sha
        idx = v.lastIndexOf("@");
        if (idx === -1) {
            throw new Error("No sha for: " + v);
        }
        deps[k] = {
            url: v.substr(0, idx),
            sha: v.substr(idx + 1)
        };

        // see if this matches our filter
        let filteredOut = filterDirs.length === 0 ? false : true;
        for (const f of filterDirs) {
            if (k.indexOf(f) !== -1)
                filteredOut = false;
        }
        if (filteredOut)
            delete deps[k];
    }
    // console.log("got deps", deps);
    return deps;
}

async function addSubmoduleDep(path, update) {
    const lastdir = process.cwd();
    try {
        console.log(`adding submodule ${path} at ${update.url}@${update.sha}`);
        await exec(`git submodule add -f ${update.url} ${path}`);
        process.chdir(path);
        const checkout = await exec(`git checkout ${update.sha}`);
        if (checkout.stdout.indexOf("is now at") !== -1) {
            throw new Error("failed to git checkout: " + checkout.stdout);
        }
        process.chdir(lastdir);
        await exec(`git add ${path}`);
        await exec(`git commit -m 'update ${path} to ${update.sha}'`);
    } catch (e) {
        let ok = false;
        if ("code" in e && "stdout" in e) {
            // no changes error is not an error
            if (e.stdout.indexOf("no changes added") !== -1
                || e.stdout.indexOf("nothing to commit") !== -1) {
                console.log("  ... not updated");
                ok = true;
            }
        }
        if (!ok) {
            throw e;
        }
    } finally {
        process.chdir(lastdir);
    }
}

async function updateSubmoduleDep(path, update) {
    const lastdir = process.cwd();
    try {
        process.chdir(path);
        console.log(`updating submodule ${path} to ${update.sha}`);
        const checkout = await exec(`git checkout ${update.sha}`);
        // console.log(checkout);
        if (checkout.stdout.indexOf("is now at") !== -1) {
            throw new Error("failed to git checkout: " + checkout.stdout);
        }
        process.chdir(lastdir);
        await exec(`git add ${path}`);
        await exec(`git commit -m 'update ${path} to ${update.sha}'`);
    } catch (e) {
        let ok = false;
        if ("code" in e && "stdout" in e) {
            // no changes error is not an error
            if (e.stdout.indexOf("no changes added") !== -1
                || e.stdout.indexOf("nothing to commit") !== -1) {
                console.log("  ... not updated");
                ok = true;
            }
        }
        if (!ok) {
            throw e;
        }
    } finally {
        process.chdir(lastdir);
    }
}

async function updateDeps(deps) {
    for (const dir of Object.keys(deps)) {
        const update = deps[dir];

        // first, change to the dep directory
        const slash = dir.lastIndexOf("/");
        const lastdir = process.cwd();
        try {
            let base = undefined;
            let file = dir;
            if (slash !== -1) {
                base = dir.substr(0, slash);
                file = dir.substr(slash + 1);

                process.chdir(base);
            }
            try {
                await fsp.access(file, fs.constants.R_OK | fs.constants.X_OK);
                await updateSubmoduleDep(file, update);
            } catch (e) {
                if (e.code === "ENOENT") {
                    await addSubmoduleDep(file, update);
                } else {
                    throw e;
                }
            }
        } catch (e) {
            throw e;
        } finally {
            process.chdir(lastdir);
        }
    }
}

async function readGClientFile(file) {
    let gf;
    try {
        gf = await fsp.open(file, "r");
        const gdata = await gf.readFile({ encoding: "utf8" });
        const depsFile = parseGClientFile(gdata);
        const df = await fsp.open(depsFile, "r");
        const ddata = await df.readFile({ encoding: "utf8" });
        await df.close();
        const deps = parseDepsFile(ddata);
        await updateDeps(deps);
    } finally {
        if (!gf) {
            console.error("no such file", file);
            return false;
        }
        await gf.close();
    }
    return true;
}

async function readGClientFiles() {
    for (const f of gclientFiles) {
        if (await readGClientFile(f)) {
            return;
        }
    }
}

(async function() {
    await readGClientFiles();
})().then(() => {
    process.exit();
}).catch(e => {
    console.error("got error", e);
    process.exit(1);
});
