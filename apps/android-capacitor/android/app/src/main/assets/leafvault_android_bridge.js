(function () {
  if (window.__LeafVaultAndroidCompatInstalled) return;
  window.__LeafVaultAndroidCompatInstalled = true;

  var bridge = window.LeafVaultAndroidBridge;
  if (!bridge || !window.URL || !window.Blob || !window.FileReader || !window.HTMLAnchorElement) return;

  var objectUrls = new Map();
  var originalCreateObjectURL = window.URL.createObjectURL ? window.URL.createObjectURL.bind(window.URL) : null;
  var originalRevokeObjectURL = window.URL.revokeObjectURL ? window.URL.revokeObjectURL.bind(window.URL) : null;
  var originalAnchorClick = window.HTMLAnchorElement.prototype.click;

  if (!originalCreateObjectURL || !originalAnchorClick) return;

  window.URL.createObjectURL = function (blob) {
    var url = originalCreateObjectURL(blob);
    try {
      if (blob instanceof Blob) objectUrls.set(url, blob);
    } catch (_) {
      /* keep the browser default behavior */
    }
    return url;
  };

  if (originalRevokeObjectURL) {
    window.URL.revokeObjectURL = function (url) {
      try {
        objectUrls.delete(url);
      } catch (_) {
        /* keep the browser default behavior */
      }
      return originalRevokeObjectURL(url);
    };
  }

  function shouldHandleDownload(anchor) {
    var href = String(anchor && anchor.href || '');
    var download = String(anchor && anchor.download || '');
    return href.indexOf('blob:') === 0 && /\.lvbackup$/i.test(download);
  }

  function saveBlob(blob, filename) {
    var reader = new FileReader();
    reader.onloadend = function () {
      var dataUrl = String(reader.result || '');
      var commaIndex = dataUrl.indexOf(',');
      var base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
      bridge.saveBackup(filename || 'leafvault-backup.lvbackup', base64, blob.type || 'application/json');
    };
    reader.onerror = function () {
      bridge.notify('备份文件保存失败，请稍后重试或改用浏览器导出。');
    };
    reader.readAsDataURL(blob);
  }

  window.HTMLAnchorElement.prototype.click = function () {
    try {
      if (shouldHandleDownload(this)) {
        var blob = objectUrls.get(String(this.href || ''));
        if (blob) {
          saveBlob(blob, String(this.download || 'leafvault-backup.lvbackup'));
          return undefined;
        }
      }
    } catch (_) {
      /* fall through to the browser default behavior */
    }
    return originalAnchorClick.apply(this, arguments);
  };
}());
