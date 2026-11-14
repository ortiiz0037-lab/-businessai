const nextConfig = {
  // Document Studio reads its font files on the server to embed them in PDFs.
  outputFileTracingIncludes: {
    '/studio/[id]/pdf': ['./public/studio/fonts/*.ttf'],
  },
  experimental: {
    serverActions: {
      // Bank statement CSV import (Finance 0026): files up to 2 MB.
      bodySizeLimit: '3mb',
      allowedOrigins: [
        'localhost:3000',
        '*.github.dev',
        '*.app.github.dev',
      ],
    },
  },
}

export default nextConfig