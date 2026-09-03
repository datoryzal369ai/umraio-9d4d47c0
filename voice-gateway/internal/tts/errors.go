package tts

import "errors"

// errorsIs keeps the sanitized classifier readable without importing errors
// at every call site.
func errorsIs(err, target error) bool { return errors.Is(err, target) }
