'use strict';

const { xmlEscape } = require('./util');

function sanitizeBundleVersion(value) {
  const cleaned = String(value || '')
    .replace(/[^\d.]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  if (!cleaned) return '1.0.0';
  const parts = cleaned.split('.').filter(Boolean).slice(0, 3);
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

function sanitizeShortVersion(value) {
  const cleaned = String(value || '')
    .replace(/[^\d.]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
  return cleaned.split('.').filter(Boolean).slice(0, 3).join('.') || '1.0';
}

function plistValue(value) {
  if (value === null || value === undefined) return '<string></string>';
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number' && Number.isFinite(value)) return `<integer>${Math.trunc(value)}</integer>`;
  if (Array.isArray(value)) {
    return `<array>${value.map((item) => plistValue(item)).join('')}</array>`;
  }
  if (typeof value === 'object') {
    return `<dict>${Object.entries(value)
      .map(([key, item]) => `<key>${xmlEscape(key)}</key>${plistValue(item)}`)
      .join('')}</dict>`;
  }
  return `<string>${xmlEscape(value)}</string>`;
}

function buildInfoPlist(options) {
  const {
    name,
    displayName,
    identifier,
    version,
    shortVersion,
    iconFile = 'icon',
    executable = 'launcher',
    minimumSystemVersion = '11.0',
    copyright = '',
    category = 'public.app-category.utilities',
    bundleVersion,
  } = options;

  const dict = {
    CFBundleDevelopmentRegion: 'zh_CN',
    CFBundleDisplayName: displayName || name,
    CFBundleExecutable: executable,
    CFBundleIconFile: iconFile,
    CFBundleIdentifier: identifier,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: name,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: sanitizeShortVersion(shortVersion || version),
    CFBundleVersion: sanitizeBundleVersion(bundleVersion || version),
    LSApplicationCategoryType: category,
    LSMinimumSystemVersion: String(minimumSystemVersion),
    LSMultipleInstancesProhibited: false,
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
    NSHumanReadableCopyright: copyright,
    NSDocumentsFolderUsageDescription: '启动打包的 Windows 应用时需要访问你选择的文档文件。',
    NSDesktopFolderUsageDescription: '启动打包的 Windows 应用时需要访问桌面文件。',
    NSDownloadsFolderUsageDescription: '启动打包的 Windows 应用时需要访问下载文件。',
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(dict)}
</plist>
`;
}

module.exports = { buildInfoPlist, sanitizeBundleVersion, sanitizeShortVersion, plistValue };
