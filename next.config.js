/** @type {import('next').NextConfig} */
const nextConfig = {
  // O guia antigo (marca Áurea) foi substituído; links já enviados por e-mail continuam funcionando.
  async redirects() {
    return [{ source: "/guia-aurea.pdf", destination: "/guia-socia.pdf", permanent: true }];
  },
  // Service worker dos avisos: nunca fica em cache, para o navegador pegar sempre a versão nova.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
