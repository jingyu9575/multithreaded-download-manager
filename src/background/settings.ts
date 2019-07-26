import { Settings } from "../common/settings.js";
import { LocalSettings } from "../util/webext/settings.js";
import { assert } from "../util/error.js";

assert(new URL((browser.runtime.getManifest() as any).background.page!,
	location.href).pathname === location.pathname)

export const localSettings = new LocalSettings(new Settings)
export const S = localSettings.data