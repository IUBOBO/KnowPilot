import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 代理目标可覆盖：本机若已有别的服务占了 127.0.0.1:3000（会抢在
// 0.0.0.0:3000 之前接住 localhost 的连接），用它指向后端仍能监听的地址。
const apiTarget = process.env.KP_API_PROXY_TARGET ?? 'http://localhost:3000';

// Vite 默认只接受 localhost 的 Host 头：经 Cloudflare Quick Tunnel / Tailscale
// Funnel / ngrok 访问时，浏览器发来的是隧道域名，会被 403「Blocked request」。
// 这里只放行这三家隧道域名（不是 `true`，免得任意 Host 都被接受）。
// 换成自己的域名时，把它加进这个数组即可。
const tunnelingHosts = ['.trycloudflare.com', '.ts.net', '.ngrok-free.app'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发期把 /api 和 /health 转给后端。
    // 这样前端代码里一律写相对路径 '/api/v1/...'，不用区分开发/生产环境，
    // 也就不存在"开发能跑、上线因为跨域或写死 localhost 而挂掉"的问题。
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
    allowedHosts: tunnelingHosts,
    fs: {
      // @knowpilot/shared 通过 workspace 软链指向仓库外的 packages/，
      // 不放行的话 Vite 会以"越出项目根目录"为由拒绝读取它的源码。
      allow: ['..', '../..'],
    },
  },
  // `vite preview` 用于"构建后长期运行"。它默认沿用 server.proxy（已实测），
  // 但 Host 白名单要单独再写一份。
  preview: {
    allowedHosts: tunnelingHosts,
  },
  optimizeDeps: {
    // 不预打包 shared：它是源码 TS，预打包后改了不生效，调试时很困惑。
    exclude: ['@knowpilot/shared'],
  },
});
