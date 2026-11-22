/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The crypto and protocol packages ship CommonJS; let Next transpile them.
  transpilePackages: ['@ghostchat/crypto', '@ghostchat/shared-types'],
  poweredByHeader: false,

  webpack: (config, { isServer, webpack }) => {
    // libsodium-wrappers-sumo is a single pre-bundled CJS file that references
    // Node built-ins (`node:fs`, `crypto`, `path`) inside feature-detection
    // branches. In the browser those branches never execute, but webpack still
    // has to resolve them, so map the `node:` scheme away and stub the modules.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, '');
      }),
    );

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }

    return config;
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
