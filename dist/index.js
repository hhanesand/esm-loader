import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { installSourceMapSupport, compareNodeVersion, resolveTsPath, transform, transformDynamicImport } from '@esbuild-kit/core-utils';
import { parseTsconfig, getTsconfig, createFilesMatcher, createPathsMatcher } from 'get-tsconfig';
import fs from 'fs';

const packageJsonCache = /* @__PURE__ */ new Map();
async function readPackageJson(filePath) {
  if (packageJsonCache.has(filePath)) {
    return packageJsonCache.get(filePath);
  }
  const exists = await fs.promises.access(filePath).then(
    () => true,
    () => false
  );
  if (!exists) {
    packageJsonCache.set(filePath, void 0);
    return;
  }
  const packageJsonString = await fs.promises.readFile(filePath, "utf8");
  try {
    const packageJson = JSON.parse(packageJsonString);
    packageJsonCache.set(filePath, packageJson);
    return packageJson;
  } catch {
    throw new Error(`Error parsing: ${filePath}`);
  }
}
async function findPackageJson(filePath) {
  let packageJsonUrl = new URL("package.json", filePath);
  while (true) {
    if (packageJsonUrl.pathname.endsWith("/node_modules/package.json")) {
      break;
    }
    const packageJsonPath = fileURLToPath(packageJsonUrl);
    const packageJson = await readPackageJson(packageJsonPath);
    if (packageJson) {
      return packageJson;
    }
    const lastPackageJSONUrl = packageJsonUrl;
    packageJsonUrl = new URL("../package.json", packageJsonUrl);
    if (packageJsonUrl.pathname === lastPackageJSONUrl.pathname) {
      break;
    }
  }
}
async function getPackageType(filePath) {
  const packageJson = await findPackageJson(filePath);
  return packageJson?.type ?? "commonjs";
}

const applySourceMap = installSourceMapSupport();
const tsconfig = process.env.ESBK_TSCONFIG_PATH ? {
  path: path.resolve(process.env.ESBK_TSCONFIG_PATH),
  config: parseTsconfig(process.env.ESBK_TSCONFIG_PATH)
} : getTsconfig();
const fileMatcher = tsconfig && createFilesMatcher(tsconfig);
const tsconfigPathsMatcher = tsconfig && createPathsMatcher(tsconfig);
const fileProtocol = "file://";
const tsExtensionsPattern = /\.([cm]?ts|[tj]sx)$/;
const getFormatFromExtension = (fileUrl) => {
  const extension = path.extname(fileUrl);
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".mjs" || extension === ".mts") {
    return "module";
  }
  if (extension === ".cjs" || extension === ".cts") {
    return "commonjs";
  }
};
const getFormatFromFileUrl = (fileUrl) => {
  const format = getFormatFromExtension(fileUrl);
  if (format) {
    return format;
  }
  if (tsExtensionsPattern.test(fileUrl)) {
    return getPackageType(fileUrl);
  }
};

const extensions = [".js", ".json", ".ts", ".tsx", ".jsx"];
async function tryExtensions(specifier, context, defaultResolve) {
  let error;
  for (const extension of extensions) {
    try {
      return await resolve(
        specifier + extension,
        context,
        defaultResolve,
        true
      );
    } catch (_error) {
      if (error === void 0) {
        const { message } = _error;
        _error.message = _error.message.replace(`${extension}'`, "'");
        _error.stack = _error.stack.replace(message, _error.message);
        error = _error;
      }
    }
  }
  throw error;
}
async function tryDirectory(specifier, context, defaultResolve) {
  const isExplicitDirectory = specifier.endsWith("/");
  const appendIndex = isExplicitDirectory ? "index" : "/index";
  try {
    return await tryExtensions(specifier + appendIndex, context, defaultResolve);
  } catch (error) {
    if (!isExplicitDirectory) {
      try {
        return await tryExtensions(specifier, context, defaultResolve);
      } catch {
      }
    }
    const { message } = error;
    error.message = error.message.replace(`${appendIndex.replace("/", path.sep)}'`, "'");
    error.stack = error.stack.replace(message, error.message);
    throw error;
  }
}
const isPathPattern = /^\.{0,2}\//;
const supportsNodePrefix = compareNodeVersion([14, 13, 1]) >= 0 || compareNodeVersion([12, 20, 0]) >= 0;
const resolve = async function(specifier, context, defaultResolve, recursiveCall) {
  if (!supportsNodePrefix && specifier.startsWith("node:")) {
    specifier = specifier.slice(5);
  }
  if (specifier.endsWith("/")) {
    return await tryDirectory(specifier, context, defaultResolve);
  }
  const isPath = specifier.startsWith(fileProtocol) || isPathPattern.test(specifier);
  if (tsconfigPathsMatcher && !isPath && !context.parentURL?.includes("/node_modules/")) {
    const possiblePaths = tsconfigPathsMatcher(specifier);
    console.log("tsconfigPathsMatcher", specifier, possiblePaths);
    for (const possiblePath of possiblePaths) {
      try {
        return await resolve(
          pathToFileURL(possiblePath).toString(),
          context,
          defaultResolve
        );
      } catch {
      }
    }
  }
  if (tsExtensionsPattern.test(context.parentURL)) {
    const tsPath = resolveTsPath(specifier);
    if (tsPath) {
      try {
        return await resolve(tsPath, context, defaultResolve, true);
      } catch (error) {
        const { code } = error;
        if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
          throw error;
        }
      } finally {
        console.log("perfer ts", specifier, tsPath);
      }
    }
  }
  let resolved;
  try {
    resolved = await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (error instanceof Error && !recursiveCall) {
      const { code } = error;
      if (code === "ERR_UNSUPPORTED_DIR_IMPORT") {
        try {
          return await tryDirectory(specifier, context, defaultResolve);
        } catch (error_) {
          if (error_.code !== "ERR_PACKAGE_IMPORT_NOT_DEFINED") {
            throw error_;
          }
        }
      }
      if (code === "ERR_MODULE_NOT_FOUND") {
        try {
          return await tryExtensions(specifier, context, defaultResolve);
        } catch {
        }
      }
    }
    throw error;
  }
  if (!resolved.format && resolved.url.startsWith(fileProtocol)) {
    resolved.format = await getFormatFromFileUrl(resolved.url);
  }
  console.log("default resolve", specifier, resolved.url, resolved.format);
  return resolved;
};
const load = async function(url, context, defaultLoad) {
  if (process.send) {
    process.send({
      type: "dependency",
      path: url
    });
  }
  if (url.endsWith(".json")) {
    if (!context.importAssertions) {
      context.importAssertions = {};
    }
    context.importAssertions.type = "json";
  }
  const loaded = await defaultLoad(url, context, defaultLoad);
  if (!loaded.source) {
    return loaded;
  }
  const filePath = url.startsWith("file://") ? fileURLToPath(url) : url;
  const code = loaded.source.toString();
  if (loaded.format === "json" || tsExtensionsPattern.test(url)) {
    const transformed = await transform(
      code,
      filePath,
      {
        tsconfigRaw: fileMatcher?.(filePath)
      }
    );
    return {
      format: "module",
      source: applySourceMap(transformed, url)
    };
  }
  if (loaded.format === "module") {
    const dynamicImportTransformed = transformDynamicImport(filePath, code);
    if (dynamicImportTransformed) {
      loaded.source = applySourceMap(
        dynamicImportTransformed,
        url
      );
    }
  }
  return loaded;
};

export { load, resolve };
