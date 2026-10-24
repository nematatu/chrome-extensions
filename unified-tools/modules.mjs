export const modules = [
  {
    "id": "instagram",
    "name": "Instagram Media Downloader",
    "source": "instagram-media-downloader",
    "files": [
      "background.js",
      "bridge.js",
      "content.js",
      "core.js",
      "instagram-api.js",
      "popup.css",
      "popup.html",
      "popup.js"
    ],
    "worker": "background.js",
    "popup": "popup.html",
    "startTypes": [
      "ig-download-start"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "gofile",
    "name": "Gofile 動画・画像一括ダウンローダー",
    "source": "gofile-bulk-video-downloader",
    "files": [
      "background.js",
      "collector.js",
      "content.js",
      "core.js",
      "page-bridge.js"
    ],
    "worker": "background.js",
    "startTypes": [
      "gofile-bulk:start",
      "gofile-bulk:retry"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "googlephotos",
    "name": "Google Photos Album Sorter",
    "source": "GooglePhoto-utils",
    "files": [
      "src/content.css",
      "src/content.js",
      "src/page-bridge.js"
    ],
    "startTypes": [],
    "contentStorage": {
      "local": [
        "gpu-albums-v2",
        "gpu-panel-collapsed-v1"
      ],
      "sync": []
    },
    "portable": {
      "area": "local",
      "keys": [
        "gpu-panel-collapsed-v1"
      ]
    }
  },
  {
    "id": "badspi",
    "name": "バドスピ 高画質画像ダウンローダー",
    "source": "badspi-hq-downloader",
    "files": [
      "LICENSE",
      "background.js",
      "content.css",
      "content.js",
      "quality-core.js"
    ],
    "worker": "background.js",
    "startTypes": [
      "badspi-download"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "birdscore",
    "name": "Birdscore Popup",
    "source": "birdcore-popup",
    "files": [
      "config.json",
      "court-youtube.json",
      "icons/icon128.png",
      "icons/icon16.png",
      "icons/icon32.png",
      "icons/icon48.png",
      "popup.css",
      "popup.html",
      "popup.js",
      "team-aliases.json"
    ],
    "popup": "popup.html",
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "inhighlinks",
    "name": "インハイTV 試合リンク",
    "source": "inhigh-tv-match-links",
    "files": [
      "birdscore-content.css",
      "birdscore-content.js",
      "data/matches.json",
      "inhigh-content.css",
      "inhigh-content.js"
    ],
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "inhighskip",
    "name": "インハイTV スキップ操作",
    "source": "inhigh-tv-skip-extension",
    "files": [
      "content.css",
      "content.js",
      "options.css",
      "options.html",
      "options.js"
    ],
    "popup": "options.html",
    "options": "options.html",
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": [
        "skipSeconds",
        "keyboardEnabled"
      ]
    },
    "portable": {
      "area": "sync",
      "keys": [
        "skipSeconds",
        "keyboardEnabled"
      ]
    }
  },
  {
    "id": "instagramhq",
    "name": "Instagram High Quality Images",
    "source": "instagram-high-quality-images",
    "files": [
      "LICENSE",
      "content.css",
      "content.js",
      "popup.css",
      "popup.html",
      "popup.js",
      "quality-core.js"
    ],
    "popup": "popup.html",
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": [
        "enabled",
        "rotateLive"
      ]
    },
    "portable": {
      "area": "sync",
      "keys": [
        "enabled",
        "rotateLive"
      ]
    }
  },
  {
    "id": "kltra",
    "name": "KLTRA 弾幕チャット",
    "source": "kltra-danmaku",
    "files": [
      "background.js",
      "chat.js",
      "danmaku.css",
      "page.js",
      "popup.css",
      "popup.html",
      "popup.js",
      "translation.js"
    ],
    "worker": "background.js",
    "popup": "popup.html",
    "startTypes": [
      "TRANSLATE_ONLINE"
    ],
    "contentStorage": {
      "local": [
        "enabled",
        "fontSize",
        "transparency",
        "position",
        "speed",
        "showName",
        "translationEnabled",
        "translationSource",
        "translationEngine"
      ],
      "sync": []
    },
    "portable": {
      "area": "local",
      "keys": [
        "enabled",
        "fontSize",
        "transparency",
        "position",
        "speed",
        "showName",
        "translationEnabled",
        "translationSource",
        "translationEngine"
      ]
    }
  },
  {
    "id": "koutairen",
    "name": "全国高体連バドミントン 写真送り修正",
    "source": "koutairen-gallery-fix",
    "files": [
      "LICENSE",
      "content.js",
      "viewer.css"
    ],
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "momoniji",
    "name": "Momoniji 漫画ビューア・一括保存",
    "source": "momoniji-manga-viewer/extension",
    "files": [
      "background.js",
      "content.js",
      "download-core.js",
      "extract.js",
      "library-content.js",
      "library-core.js",
      "popup.css",
      "popup.html",
      "popup.js",
      "vendor/LICENSE.manga-viewer",
      "vendor/manga-viewer.js",
      "vendor/provenance.json"
    ],
    "worker": "background.js",
    "popup": "popup.html",
    "startTypes": [
      "MOMONIJI_DOWNLOAD_START",
      "MOMONIJI_DOWNLOAD_RETRY",
      "MOMONIJI_LIBRARY_SAVE"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "pagemedia",
    "name": "ページ動画・画像 一括保存",
    "source": "page-media-bulk-downloader",
    "files": [
      "background.js",
      "collector.js",
      "content.js",
      "core.js",
      "hls.js",
      "hosted-collector.js",
      "mp4.js",
      "offscreen.html",
      "offscreen.js",
      "vendor/mux.js-LICENSE",
      "vendor/mux.min.js"
    ],
    "worker": "background.js",
    "offscreen": "offscreen.html",
    "startTypes": [
      "page-media-bulk:start",
      "page-media-bulk:retry"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "r2",
    "name": "R2 Image Preview",
    "source": "r2-image-preview",
    "files": [
      "content.css",
      "content.js",
      "options.css",
      "options.html",
      "options.js"
    ],
    "options": "options.html",
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": [
        "baseUrlTemplate",
        "maxWidth",
        "maxHeight",
        "hoverOnly",
        "showNonImages"
      ]
    },
    "portable": {
      "area": "sync",
      "keys": [
        "baseUrlTemplate",
        "maxWidth",
        "maxHeight",
        "hoverOnly",
        "showNonImages"
      ]
    }
  },
  {
    "id": "smashnet",
    "name": "SMASH and NET. TV Photo Gallery Plus",
    "source": "smashAndNetTV-better-photo-garally",
    "files": [
      "background.js",
      "content.js",
      "styles.css",
      "viewer.js"
    ],
    "worker": "background.js",
    "startTypes": [
      "download-photo"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "stripchat",
    "name": "Stripchat ライブ・ホバープレビュー",
    "source": "stripchat-live-hover",
    "files": [
      "content.css",
      "content.js",
      "core.js",
      "native-preview.js"
    ],
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "sushida",
    "name": "Sushida Log",
    "source": "sushida-log",
    "files": [
      "src/background.js",
      "src/content.js",
      "src/page-bridge.js",
      "src/parser.js",
      "src/popup.css",
      "src/popup.html",
      "src/popup.js"
    ],
    "worker": "src/background.js",
    "popup": "src/popup.html",
    "startTypes": [
      "SUSHIDA_RESULT_DETECTED",
      "SUSHIDA_SAVE_MANUAL_RESULT",
      "SUSHIDA_RESULT_NETWORK_DETECTED",
      "SUSHIDA_DEBUG_EVENT"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    },
    "portable": {
      "area": "local",
      "keys": [
        "settings"
      ]
    }
  },
  {
    "id": "tweetfile",
    "name": "Tweetfile 動画一括ダウンローダー",
    "source": "tweetfile-video-downloader",
    "files": [
      "background.js",
      "content.js",
      "hls.js",
      "mp4.js",
      "offscreen.html",
      "offscreen.js",
      "page-bridge.js",
      "vendor/mux.js-LICENSE",
      "vendor/mux.min.js"
    ],
    "worker": "background.js",
    "offscreen": "offscreen.html",
    "startTypes": [
      "tweetfile-download"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  },
  {
    "id": "xhashtags",
    "name": "X Hashtag Autofill",
    "source": "x-hashtag-autofill",
    "files": [
      "LICENSE",
      "content.js",
      "popup.css",
      "popup.html",
      "popup.js"
    ],
    "popup": "popup.html",
    "startTypes": [],
    "contentStorage": {
      "local": [],
      "sync": [
        "hashtags"
      ]
    },
    "portable": {
      "area": "sync",
      "keys": [
        "hashtags"
      ]
    }
  },
  {
    "id": "youtube",
    "name": "YouTube 範囲指定MP4クリップ",
    "source": "youtube-five-second-clip",
    "files": [
      "background.js",
      "clip.js",
      "collector.js",
      "content.js",
      "convert.mjs",
      "offscreen.html",
      "offscreen.mjs",
      "popup.html",
      "popup.js",
      "stream-cache.js",
      "vendor/mediabunny-LICENSE",
      "vendor/mediabunny.mjs"
    ],
    "worker": "background.js",
    "popup": "popup.html",
    "offscreen": "offscreen.html",
    "startTypes": [
      "clip"
    ],
    "contentStorage": {
      "local": [],
      "sync": []
    }
  }
];
