'use strict';

const fs = require('fs');
const path = require('path');

function nonemptyFile(file) {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() && stats.size > 0;
  } catch (_) {
    return false;
  }
}

function resolvePackagedServer({ resourcesPath, platform = process.platform }) {
  const executable = platform === 'win32' ? 'my-scholar-server.exe' : 'my-scholar-server';
  const command = path.join(resourcesPath, 'python-server', executable);
  if (!nonemptyFile(command)) throw new Error('应用包缺少本地文献服务。请重新安装谷子学术。');
  return { command, args: [], source: 'bundled-server' };
}

function packagedToolchainEnvironment({ resourcesPath, platform = process.platform }) {
  const suffix = platform === 'win32' ? '.exe' : '';
  const jar = path.join(resourcesPath, 'toolchain', 'opendataloader-pdf-cli-0.0.0.jar');
  const pandoc = path.join(resourcesPath, 'toolchain', 'pandoc', `pandoc${suffix}`);
  const java = path.join(resourcesPath, 'java', 'bin', `java${suffix}`);
  const renderer = path.join(resourcesPath, 'toolchain', 'pdf-renderer');
  const caBundle = path.join(resourcesPath, 'python-server', 'ca-certificates.crt');
  if (![jar, pandoc, java, path.join(renderer, 'MyScholarPdfRenderer.class')].every(nonemptyFile)) {
    throw new Error('应用包缺少 PDF 转换组件。请重新安装谷子学术。');
  }
  if (!nonemptyFile(caBundle)) throw new Error('应用包缺少 HTTPS 信任证书。请重新安装谷子学术。');
  const classpathDelimiter = platform === 'win32' ? ';' : ':';
  return {
    MY_SCHOLAR_ODL_JAR: jar,
    MY_SCHOLAR_PANDOC: pandoc,
    MY_SCHOLAR_JAVA: java,
    MY_SCHOLAR_PDF_RENDERER_CLASSPATH: `${renderer}${classpathDelimiter}${jar}`,
    SSL_CERT_FILE: caBundle,
  };
}

module.exports = { packagedToolchainEnvironment, resolvePackagedServer };
