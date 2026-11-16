package kartochki

import "embed"

// Web is the single frontend used by both native applications.
//
//go:embed web
var Web embed.FS
