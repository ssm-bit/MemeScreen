import { defineConfig } from 'vite';
import { resolve } from 'path';

// MS_BASE is the sub-path the site is served from. GitHub Pages serves the repo at /MemeScreen/, so the
// Pages workflow sets MS_BASE=/MemeScreen/. Local dev and Netlify use the default '/'.
export default defineConfig({
  root: 'src',
  base: process.env.MS_BASE || '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // two pages: the app itself, and the phone simulator that frames it
    rollupOptions: { input: { main: resolve(__dirname, 'src/index.html'), phone: resolve(__dirname, 'src/phone.html'), join: resolve(__dirname, 'src/join.html') } },
  },
  clearScreen: false,
  // host:true also serves the app on your Wi-Fi address so a real phone can open it
  // allowedHosts lets the public tunnel address (…trycloudflare.com) through
  server: { port: 5173, strictPort: true, host: true, allowedHosts: true },
});
