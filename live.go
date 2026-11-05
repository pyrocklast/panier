package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Live updates: a WebSocket that carries the latest sequence number whenever it
// changes. This is the small part of RFC 6455 the app needs, using only the standard
// library: the handshake, unfragmented text frames out, and pings and close in.
//
// Browsers can't set headers on WebSockets, so the app offers two subprotocols,
// "panier" and its access token; the server accepts "panier".

const (
	wsGUID      = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	wsIdle      = 90 * time.Second // the app pings every 30 seconds
	wsWriteWait = 10 * time.Second
	wsMaxFrame  = 1024
)

const (
	opText  = 0x1
	opClose = 0x8
	opPing  = 0x9
	opPong  = 0xA
)

// protocolToken returns the access token offered as a WebSocket subprotocol.
func protocolToken(r *http.Request) string {
	var offered []string
	for _, v := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, p := range strings.Split(v, ",") {
			offered = append(offered, strings.TrimSpace(p))
		}
	}
	hasPanier, token := false, ""
	for _, p := range offered {
		if p == "panier" {
			hasPanier = true
		} else if token == "" {
			token = p
		}
	}
	if !hasPanier {
		return ""
	}
	return token
}

func headerHas(r *http.Request, name, token string) bool {
	for _, v := range r.Header.Values(name) {
		for _, p := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(p), token) {
				return true
			}
		}
	}
	return false
}

func (sv *server) live(w http.ResponseWriter, r *http.Request, l *list) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if k, err := base64.StdEncoding.DecodeString(key); err != nil || len(k) != 16 ||
		!headerHas(r, "Upgrade", "websocket") || !headerHas(r, "Connection", "upgrade") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" {
		fail(w, http.StatusUpgradeRequired, "expected a WebSocket")
		return
	}
	ch, stop, ok := l.subscribe(maxListeners)
	if !ok {
		fail(w, http.StatusTooManyRequests, "too many connections")
		return
	}
	defer stop()

	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(key + wsGUID))
	rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n" +
		"Sec-WebSocket-Protocol: panier\r\n\r\n")
	if rw.Flush() != nil {
		return
	}

	ws := &wsConn{conn: conn}
	done := make(chan struct{})
	go func() {
		defer close(done)
		ws.readLoop(rw.Reader)
	}()
	if ws.send(opText, []byte(strconv.Itoa(l.latest()))) != nil {
		return
	}
	for {
		select {
		case <-done:
			return
		case n := <-ch:
			if ws.send(opText, []byte(strconv.Itoa(n))) != nil {
				return
			}
		}
	}
}

type wsConn struct {
	conn net.Conn
	mu   sync.Mutex
}

func (c *wsConn) send(op byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
	_, err := c.conn.Write(wsFrame(op, payload))
	return err
}

// readLoop answers pings and returns when the phone closes, goes quiet, or breaks the protocol.
func (c *wsConn) readLoop(r *bufio.Reader) {
	for {
		c.conn.SetReadDeadline(time.Now().Add(wsIdle))
		op, payload, err := wsRead(r)
		if err != nil {
			code := uint16(1002)
			if errors.Is(err, errTooBig) {
				code = 1009
			}
			c.send(opClose, binary.BigEndian.AppendUint16(nil, code))
			return
		}
		switch op {
		case opClose:
			c.send(opClose, nil)
			return
		case opPing:
			c.send(opPong, payload)
		case opText:
			if string(payload) == "ping" {
				c.send(opText, []byte("pong"))
			}
		}
	}
}

// wsFrame builds an unmasked, unfragmented server frame.
func wsFrame(op byte, payload []byte) []byte {
	b := []byte{0x80 | op}
	if n := len(payload); n < 126 {
		b = append(b, byte(n))
	} else {
		b = append(b, 126)
		b = binary.BigEndian.AppendUint16(b, uint16(n))
	}
	return append(b, payload...)
}

var (
	errProtocol = errors.New("websocket protocol error")
	errTooBig   = errors.New("websocket frame too big")
)

// wsRead reads one frame from the phone. Frames from browsers are always masked.
func wsRead(r *bufio.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	fin, op := h[0]&0x80 != 0, h[0]&0x0f
	if h[0]&0x70 != 0 || h[1]&0x80 == 0 {
		return 0, nil, errProtocol
	}
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if op >= 0x8 && (n > 125 || !fin) {
		return 0, nil, errProtocol
	}
	if n > wsMaxFrame {
		return 0, nil, errTooBig
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return op, payload, nil
}
