import { getTsconfig, TsConfigResult } from "get-tsconfig"

const tsConfigPathsCache = new Map<string, string>();
const tsConfigPathCache = new Map<string, string>();
const tsConfigCache = new Map<string, TsConfigResult | undefined>();

export async function cachedTsConfig(filePath: string): Promise<TsConfigResult | undefined> {
	const cachedPath = tsConfigPathsCache.get(filePath);
	if (cachedPath) {
		const cachedConfig = tsConfigCache.get(cachedPath);
		if (cachedConfig) {
			return cachedConfig;
		}

		console.error("cachedTsConfig: cachedPath not found", cachedPath);
		throw new Error("cachedTsConfig: cachedPath not found");
	}

	try {
		const tsConfig = getTsconfig(filePath);
		if (!tsConfig) {
			return undefined;
		}

		if (!tsConfigCache.has(tsConfig.path)) {
			tsConfigCache.set(tsConfig.path, tsConfig)
		}

		tsConfigPathsCache.set(filePath, tsConfig.path);
		return tsConfig;
	} catch {
		throw new Error(`Error parsing: ${filePath}`);
	}
}
