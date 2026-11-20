import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const providerDevPaths: Record<string, string> = {
  'https://open.bigmodel.cn': '/_provider_dev/glm',
  'https://api.z.ai': '/_provider_dev/zai',
  'https://dashscope.aliyuncs.com': '/_provider_dev/qwen',
  'https://dashscope-intl.aliyuncs.com': '/_provider_dev/qwen-intl',
  'https://dashscope-us.aliyuncs.com': '/_provider_dev/qwen-us',
  'https://tokenhub.tencentmaas.com': '/_provider_dev/hunyuan',
  'https://tokenhub.tencentcloudmaas.com': '/_provider_dev/hunyuan-cloud',
  'https://tokenhub-intl.tencentcloudmaas.com': '/_provider_dev/hunyuan-intl',
  'https://api.x.ai': '/_provider_dev/grok',
}
const root = path.dirname(fileURLToPath(import.meta.url))
const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
      {
        test: /\.md$/,
        include: path.resolve(root, 'src/services/chat/prompts'),
        type: 'asset/source',
      },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __PROVIDER_DEV_PATHS__: JSON.stringify(dev ? providerDevPaths : {}),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
        // Android's local asset handler serves bundled dependencies under /static/.
        ...[
          ['legacy/build/pdf.min.mjs', 'pdf.js'],
          ['legacy/build/pdf.worker.min.mjs', 'worker.js'],
          ['LICENSE', 'LICENSE'],
          ...['cmaps', 'standard_fonts'].map((name) => [name, name]),
          ...[
            'openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js',
            'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2',
          ].map((name) => [`wasm/${name}`, `wasm/${name}`]),
        ].map(([from, to]) => ({ from: path.join(pdfjsRoot, from), to: `static/pdfjs/${to}` })),
      ],
    }),
  ],
  performance: { hints: false },
  devServer: {
    host: '127.0.0.1',
    port: 8090,
    proxy: Object.entries(providerDevPaths).map(([target, prefix]) => ({
      context: [
        `${prefix}/api/paas/v4/models`,
        `${prefix}/api/paas/v4/chat/completions`,
        `${prefix}/api/v1/models`,
        `${prefix}/compatible-mode/v1/chat/completions`,
        // 混元 TokenHub / xAI Grok
        `${prefix}/v1/models`,
        `${prefix}/v1/chat/completions`,
        `${prefix}/v1/responses`,
      ],
      target,
      changeOrigin: true,
      pathRewrite: { [`^${prefix}`]: '' },
    })),
    ...devServer,
  },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
