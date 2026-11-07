export const SCREENSHOT_LIMIT = 4;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SCREENSHOT_MAX_ENCODED_LENGTH = 'data:image/png;base64,'.length + 4 * Math.ceil(SCREENSHOT_MAX_BYTES / 3);
export const SCREENSHOT_PATH = /^\.sat\/screenshots\/[\w-]+\.png$/;
export const COMMENT_SCREENSHOT = /^\[скриншот\] (\/api\/images\/([a-z0-9]{8,64}\.(?:png|jpg|webp|gif))(?:\?workspace=([\w%-]+))?)$/;
