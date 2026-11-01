/** @type {import('next').NextConfig} */
const nextConfig = {
  // O guia antigo (marca Áurea) foi substituído; links já enviados por e-mail continuam funcionando.
  async redirects() {
    return [{ source: "/guia-aurea.pdf", destination: "/guia-socia.pdf", permanent: true }];
  },
};
module.exports = nextConfig;
