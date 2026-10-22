#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
BUILD_DIR="${PROJECT_DIR}/build"
RUNTIME_DIR="${BUILD_DIR}/mac-runtime"
PYINSTALLER_ENV="${BUILD_DIR}/pyinstaller-env"
BUILD_PYTHON="${MY_SCHOLAR_BUILD_PYTHON:-}"
if [[ -z "${BUILD_PYTHON}" ]]; then
  for candidate in "${commands[python3]-}" /opt/anaconda3/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [[ -n "${candidate}" && -x "${candidate}" ]] && "${candidate}" -c 'import certifi, hashlib; assert hasattr(hashlib, "scrypt")' >/dev/null 2>&1; then
      BUILD_PYTHON="${candidate}"
      break
    fi
  done
fi
ODL_JAR="${MY_SCHOLAR_ODL_JAR:-}"
if [[ -z "${ODL_JAR}" ]]; then
  ODL_JAR="$(zsh "${SCRIPT_DIR}/fetch-opendataloader.sh")"
fi
PANDOC_FETCHER="${SCRIPT_DIR}/fetch-pandoc.sh"
if [[ ! -f "${PANDOC_FETCHER}" ]]; then
  print -u2 "缺少 Pandoc 获取脚本：${PANDOC_FETCHER}"
  exit 1
fi
PANDOC_PATH="${MY_SCHOLAR_PANDOC:-}"
if [[ -z "${PANDOC_PATH}" ]]; then
  PANDOC_PATH="$(zsh "${PANDOC_FETCHER}")"
elif [[ ! -s "${BUILD_DIR}/toolchain/licenses/pandoc/COPYING.md" ]]; then
  zsh "${PANDOC_FETCHER}" >/dev/null
fi
EXPECTED_ODL_SHA256="${MY_SCHOLAR_ODL_SHA256:-104a5523c812ba3a43a3c7dd6156e33f23d0e32f03ef1ac629009ef96d7a79e1}"
JAVA_HOME_PATH="${MY_SCHOLAR_JAVA_HOME:-}"
if [[ -z "${JAVA_HOME_PATH}" ]]; then
  JAVA_HOME_PATH="$(/usr/libexec/java_home 2>/dev/null || true)"
fi
CA_BUNDLE_NAME="ca-certificates.crt"
PYINSTALLER_PACKAGES=(
  'altgraph==0.17.5'
  'macholib==1.16.4'
  'packaging==26.3'
  'pyinstaller-hooks-contrib==2026.6'
  'setuptools==83.0.0'
  'pyinstaller==6.16.0'
  'PyMuPDF==1.28.2'
)

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 "首版构建仅支持 Apple Silicon macOS。"
  exit 1
fi
if [[ ! -x "${BUILD_PYTHON}" ]]; then
  print -u2 "找不到用于构建独立服务的 Python；请安装 arm64 Python 或设置 MY_SCHOLAR_BUILD_PYTHON。"
  exit 1
fi
BUILD_PYTHON_ID="$("${BUILD_PYTHON}" -c 'import platform,sys; print(f"{sys.version_info.major}.{sys.version_info.minor}-{platform.machine()}")')"
if [[ "${BUILD_PYTHON_ID}" != *-arm64 ]]; then
  print -u2 "构建 Python 必须是 arm64：${BUILD_PYTHON_ID}"
  exit 1
fi
if ! CERTIFI_CA="$("${BUILD_PYTHON}" -c 'import certifi; print(certifi.where())' 2>/dev/null)" || [[ ! -s "${CERTIFI_CA}" ]]; then
  print -u2 "构建 Python 缺少可用的 certifi CA bundle：${BUILD_PYTHON}"
  exit 1
fi
if [[ ! -f "${ODL_JAR}" ]]; then
  print -u2 "找不到 OpenDataLoader 转换组件：${ODL_JAR}"
  exit 1
fi
if [[ ! -x "${PANDOC_PATH}" ]]; then
  print -u2 "找不到可用的 arm64 Pandoc：${PANDOC_PATH}"
  exit 1
fi
if [[ "$(file -b "${PANDOC_PATH}")" != *"Mach-O 64-bit executable arm64"* ]]; then
  print -u2 "Pandoc 架构不是 arm64：${PANDOC_PATH}"
  exit 1
fi
ACTUAL_ODL_SHA256="$(shasum -a 256 "${ODL_JAR}" | awk '{print $1}')"
if [[ "${ACTUAL_ODL_SHA256}" != "${EXPECTED_ODL_SHA256}" ]]; then
  print -u2 "OpenDataLoader 组件校验失败：${ACTUAL_ODL_SHA256}"
  exit 1
fi
if [[ ! -x "${JAVA_HOME_PATH}/bin/jlink" ]]; then
  print -u2 "找不到可用的 arm64 JDK；请安装 JDK 或设置 MY_SCHOLAR_JAVA_HOME。"
  exit 1
fi
JAVA_BUILD_ARCH="$("${JAVA_HOME_PATH}/bin/java" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/os.arch =/ {print $2; exit}')"
if [[ "${JAVA_BUILD_ARCH}" != "aarch64" ]]; then
  print -u2 "构建 JDK 必须是 arm64：${JAVA_BUILD_ARCH}"
  exit 1
fi
if [[ "${MY_SCHOLAR_RELEASE_BUILD:-0}" == "1" ]]; then
  if [[ "${BUILD_PYTHON_ID}" != 3.11-arm64 ]]; then
    print -u2 "正式发布固定使用 arm64 Python 3.11，当前为 ${BUILD_PYTHON_ID}。"
    exit 1
  fi
  JAVA_BUILD_MAJOR="$("${JAVA_HOME_PATH}/bin/java" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.specification.version =/ {print $2; exit}')"
  if [[ "${JAVA_BUILD_MAJOR}" != "21" ]]; then
    print -u2 "正式发布固定使用 JDK 21，当前为 ${JAVA_BUILD_MAJOR}。"
    exit 1
  fi
fi

mkdir -p "${BUILD_DIR}" "${RUNTIME_DIR}"
if [[ -x "${PYINSTALLER_ENV}/bin/python3" ]]; then
  ENV_PYTHON_ID="$("${PYINSTALLER_ENV}/bin/python3" -c 'import platform,sys; print(f"{sys.version_info.major}.{sys.version_info.minor}-{platform.machine()}")' 2>/dev/null || true)"
  if [[ "${ENV_PYTHON_ID}" != "${BUILD_PYTHON_ID}" ]]; then
    rm -rf "${PYINSTALLER_ENV}"
  fi
fi
if [[ ! -x "${PYINSTALLER_ENV}/bin/python3" ]]; then
  "${BUILD_PYTHON}" -m venv "${PYINSTALLER_ENV}"
fi
if ! "${PYINSTALLER_ENV}/bin/python3" -c '
import importlib.metadata as metadata
expected = {
    "altgraph": "0.17.5",
    "macholib": "1.16.4",
    "packaging": "26.3",
    "pyinstaller-hooks-contrib": "2026.6",
    "setuptools": "83.0.0",
    "pyinstaller": "6.16.0",
    "PyMuPDF": "1.28.2",
}
raise SystemExit(0 if all(metadata.version(name) == version for name, version in expected.items()) else 1)
' >/dev/null 2>&1; then
  "${PYINSTALLER_ENV}/bin/python3" -m pip install --disable-pip-version-check \
    "${PYINSTALLER_PACKAGES[@]}"
fi

# The Codex Python distribution loads this policy file relative to ssl.py.
# Preserve it in the frozen runtime instead of changing its TLS policy.
SSL_POLICY_FILE="$("${PYINSTALLER_ENV}/bin/python3" -c 'import pathlib, ssl; print(pathlib.Path(ssl.__file__).with_name("codex-rejected-cas.pem"))')"
PYINSTALLER_SSL_DATA=()
if [[ -f "${SSL_POLICY_FILE}" ]]; then
  PYINSTALLER_SSL_DATA=(--add-data "${SSL_POLICY_FILE}:.")
fi

"${PYINSTALLER_ENV}/bin/python3" -m PyInstaller \
  --clean \
  --noconfirm \
  --onedir \
  --name my-scholar-server \
  --distpath "${RUNTIME_DIR}" \
  --workpath "${BUILD_DIR}/pyinstaller-work" \
  --specpath "${BUILD_DIR}" \
  --collect-binaries pymupdf \
  --copy-metadata pymupdf \
  --add-data "${PROJECT_DIR}/resources/licenses/pdf-runtime:licenses/pdf-runtime" \
  "${PYINSTALLER_SSL_DATA[@]}" \
  "${PROJECT_DIR}/server.py"

cp "${CERTIFI_CA}" "${RUNTIME_DIR}/my-scholar-server/${CA_BUNDLE_NAME}"
cp "${ODL_JAR}" "${RUNTIME_DIR}/opendataloader-pdf-cli-0.0.0.jar"
mkdir -p "${RUNTIME_DIR}/pandoc"
cp "${PANDOC_PATH}" "${RUNTIME_DIR}/pandoc/pandoc"
chmod 755 "${RUNTIME_DIR}/pandoc/pandoc"
mkdir -p "${RUNTIME_DIR}/pdf-renderer"
"${JAVA_HOME_PATH}/bin/javac" \
  --release 11 \
  -cp "${ODL_JAR}" \
  -d "${RUNTIME_DIR}/pdf-renderer" \
  "${SCRIPT_DIR}/MyScholarPdfRenderer.java"
rm -rf "${RUNTIME_DIR}/java.next"
"${JAVA_HOME_PATH}/bin/jlink" \
  --add-modules java.base,java.compiler,java.desktop,java.management,java.sql \
  --strip-debug \
  --no-header-files \
  --no-man-pages \
  --compress=zip-6 \
  --output "${RUNTIME_DIR}/java.next"
rm -rf "${RUNTIME_DIR}/java"
mv "${RUNTIME_DIR}/java.next" "${RUNTIME_DIR}/java"

"${RUNTIME_DIR}/my-scholar-server/my-scholar-server" --help >/dev/null
SSL_CERT_FILE="${RUNTIME_DIR}/my-scholar-server/${CA_BUNDLE_NAME}" \
  "${RUNTIME_DIR}/my-scholar-server/my-scholar-server" --dependency-smoke >/dev/null
"${RUNTIME_DIR}/java/bin/java" -version >/dev/null 2>&1
test -s "${RUNTIME_DIR}/my-scholar-server/${CA_BUNDLE_NAME}"
test -x "${RUNTIME_DIR}/pandoc/pandoc"
"${RUNTIME_DIR}/pandoc/pandoc" --version | grep -F "pandoc ${MY_SCHOLAR_PANDOC_VERSION:-3.10.2}" >/dev/null
test -f "${RUNTIME_DIR}/pdf-renderer/MyScholarPdfRenderer.class"
print "macOS 独立运行时已准备完成：${RUNTIME_DIR}"
