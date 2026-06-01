package iot

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

func generateID(prefix string) string {
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b))
}

func nowMs() int64 {
	return time.Now().UnixMilli()
}
