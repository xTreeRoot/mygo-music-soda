The public endpoint and metadata adapters were developed with reference to qishui-api (https://github.com/guowenye/qishui-api), Copyright (c) 2026 arrow, MIT. The license text is included in LICENSE.

The login-page QR encoder embeds the unmodified qrcode-generator 2.0.4 browser distribution (https://www.npmjs.com/package/qrcode-generator), Copyright (c) 2009 Kazuhiko Arase, MIT. The full MIT grant and disclaimer in LICENSE apply to this component under this copyright notice. Official security scripts are loaded directly from the platform CDN into the ephemeral login page; they are not bundled or modified.

The isolated login page bundles unmodified React 18.3.1 and ReactDOM 18.3.1 production UMD distributions (MIT, Copyright (c) Meta Platforms, Inc. and affiliates), from the official npm packages. Their license is retained in vendor/LICENSE-react. vendor/verification-runtime.js only serializes the original files as a module string for the host HTML contract.

The official Passport verification API contract was cross-checked against the reviewed local source of lane128/mygo-music-qishui (revision 94d4af3a2b0be181332690ba3c93caeecc291122, native/login/page) and SodaMusic 3.7.0. No helper binaries or private sessions are included.
