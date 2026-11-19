'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const { t } = require('./i18n');

function safeMessage(value, profile = '') {
  let text = String(value || t('connNoErrorDetail')).split(/\r?\n/)[0];
  if (profile) {
    text = text.split(profile).join(t('connRedactedProfile'));
    const storage = path.dirname(profile);
    if (path.isAbsolute(storage)) text = text.split(storage).join(t('connRedactedStorage'));
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return t('connRedactedUrl');
      }
    })
    .slice(0, 600);
}
function connectionFailure(error, stage, options = {}) {
  if (error?.connectionFailure) return error.connectionFailure;
  const text = String(error?.message || error),
    native = text.match(/\b(?:ERR_[A-Z_]+|EACCES|EPERM|ENOTDIR|ENOSPC)\b/)?.[0];
  let code = 'BROWSER_CONNECTION_FAILED',
    hint = t('connHintDefault');
  if (stage === 'url') {
    code = 'BROWSER_URL_INVALID';
    hint = t('connHintUrlInvalid');
  } else if (stage === 'profile') {
    code = 'PROFILE_ACCESS_FAILED';
    hint = t('connHintProfileAccess');
  } else if (stage === 'panel') {
    code = 'BROWSER_PANEL_FAILED';
    hint = t('connHintPanelFailed');
  } else if (
    /ProcessSingleton|SingletonLock|user data directory.*in use|profile.*(?:in use|locked)/i.test(text)
  ) {
    code = 'PROFILE_IN_USE';
    hint = t('connHintProfileInUse');
  } else if (/executable.*(?:doesn.t exist|not found|does not exist)|distribution.*not found/i.test(text)) {
    code = 'BROWSER_NOT_FOUND';
    hint = t('connHintBrowserNotFound');
  } else if (/ERR_CERT_/i.test(text)) {
    code = 'BROWSER_CERTIFICATE_FAILED';
    hint = t('connHintCertificateFailed');
  } else if (/ERR_.*(?:PROXY|TUNNEL)/i.test(text)) {
    code = 'BROWSER_PROXY_FAILED';
    hint = t('connHintProxyFailed');
  } else if (/EACCES|EPERM|access.*denied|permission denied/i.test(text)) {
    code = 'BROWSER_ACCESS_DENIED';
    hint = t('connHintAccessDenied');
  } else if (stage === 'navigation' && (/Timeout|timed out/i.test(text) || error?.name === 'TimeoutError')) {
    code = 'BROWSER_NAVIGATION_TIMEOUT';
    hint = t('connHintNavigationTimeout');
  } else if (stage === 'navigation') {
    code = 'BROWSER_NAVIGATION_FAILED';
    hint = t('connHintNavigationFailed');
  }
  return {
    stage,
    code,
    nativeCode: native || null,
    channel: options.channel || 'msedge',
    display: options.embedded ? 'editor' : 'external',
    detail: safeMessage(text, options.profile),
    browserLog:
      stage === 'launch'
        ? text
            .split(/\r?\n/)
            .slice(1)
            .filter(
              (line) =>
                /error|failed|denied|exception|policy|singleton|ERR_|exitCode|signal/i.test(line) &&
                !/<launching>|--user-data-dir/i.test(line),
            )
            .slice(-4)
            .map((line) => safeMessage(line, options.profile))
        : [],
    hint,
  };
}
function connectionError(error, stage, options) {
  const info = connectionFailure(error, stage, options);
  const wrapped = new Error(
    t('errBrowserConnectionFailed', {
      code: info.code,
      stage: info.stage,
      detail: info.detail,
      hint: info.hint,
    }),
    { cause: error },
  );
  wrapped.code = info.code;
  wrapped.connectionFailure = info;
  return wrapped;
}

async function environmentDiagnostics({
  profile,
  channel = 'msedge',
  embedded = true,
  version,
  vscodeVersion,
}) {
  const report = {
    version,
    vscodeVersion,
    nodeVersion: process.version,
    osRelease: os.release(),
    platform: process.platform,
    architecture: process.arch,
    channel,
    display: embedded ? 'editor' : 'external',
    defaultExecutableFound: null,
    profileWritable: false,
  };
  if (process.platform === 'win32') {
    const suffix =
      channel === 'chrome'
        ? ['Google', 'Chrome', 'Application', 'chrome.exe']
        : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    report.defaultExecutableFound = false;
    for (const base of [
      process.env['PROGRAMFILES(X86)'],
      process.env.PROGRAMFILES,
      process.env.LOCALAPPDATA,
    ].filter(Boolean)) {
      if (
        await fs
          .stat(path.join(base, ...suffix))
          .then((stat) => stat.isFile())
          .catch(() => false)
      ) {
        report.defaultExecutableFound = true;
        break;
      }
    }
  }
  const probe = path.join(profile, '.m365-connection-probe-' + randomUUID());
  let handle;
  try {
    await fs.mkdir(profile, { recursive: true });
    handle = await fs.open(probe, 'wx');
    report.profileWritable = true;
  } catch (error) {
    report.profileError = safeMessage(error.message, profile);
    report.profileWritable = false;
  } finally {
    if (handle) {
      await handle.close();
      await fs.unlink(probe);
    }
  }
  return report;
}
module.exports = { connectionFailure, connectionError, environmentDiagnostics };
