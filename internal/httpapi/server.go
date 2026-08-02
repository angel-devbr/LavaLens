package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/example/lavalens/internal/ingest"
	"github.com/example/lavalens/internal/model"
	"github.com/example/lavalens/internal/store"
)

type Server struct {
	store     *store.Store
	token     string
	startedAt time.Time
	logger    *slog.Logger
}

func New(st *store.Store, token string, logger *slog.Logger) http.Handler {
	s := &Server{store: st, token: token, startedAt: time.Now().UTC(), logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /v1/status", s.status)
	mux.HandleFunc("GET /v1/guilds", s.listGuilds)
	mux.HandleFunc("GET /v1/guilds/{guildId}/player", s.getPlayer)
	mux.HandleFunc("PUT /v1/guilds/{guildId}/player", s.putPlayer)
	mux.HandleFunc("DELETE /v1/guilds/{guildId}/player", s.deletePlayer)
	mux.HandleFunc("GET /v1/guilds/{guildId}/events", s.events)
	mux.HandleFunc("POST /v1/guilds/{guildId}/events", s.postEvent)
	mux.HandleFunc("POST /v1/guilds/{guildId}/commands", s.postCommand)
	mux.HandleFunc("POST /v1/ingest/lavalink", s.ingestLavalink)
	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path != "/health" && !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Server) authorized(r *http.Request) bool {
	if s.token == "" {
		return true
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	got := strings.TrimPrefix(header, "Bearer ")
	if len(got) != len(s.token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}
func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "lavalens", "apiVersion": model.APIVersion})
}
func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	guilds, subscribers := s.store.Counts()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	writeJSON(w, http.StatusOK, map[string]any{"service": "lavalens", "apiVersion": model.APIVersion, "uptimeMs": time.Since(s.startedAt).Milliseconds(), "guilds": guilds, "subscribers": subscribers, "goroutines": runtime.NumGoroutine(), "memoryUsedBytes": mem.Alloc, "memorySystemBytes": mem.Sys})
}
func (s *Server) listGuilds(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"data": s.store.ListSnapshots()})
}
func (s *Server) getPlayer(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.Snapshot(r.PathValue("guildId"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "player_not_found", "no state is registered for this guild")
		return
	}
	writeJSON(w, http.StatusOK, v)
}
func (s *Server) putPlayer(w http.ResponseWriter, r *http.Request) {
	guildID := r.PathValue("guildId")
	var v model.Snapshot
	if err := decodeJSON(w, r, &v); err != nil {
		return
	}
	if v.GuildID != "" && v.GuildID != guildID {
		writeError(w, http.StatusBadRequest, "guild_mismatch", "guildId in URL and body differ")
		return
	}
	v.APIVersion = model.APIVersion
	v.GuildID = guildID
	v.Discord.GuildID = guildID
	v.UpdatedAt = time.Now().UTC()
	if v.Audio.Codec == "" {
		v.Audio.Codec = "opus"
	}
	if v.Audio.SampleRateHz == 0 {
		v.Audio.SampleRateHz = 48000
	}
	if v.Audio.Channels == 0 {
		v.Audio.Channels = 2
	}
	s.store.PutSnapshot(v)
	s.store.Publish(newEvent(guildID, "player.snapshot", map[string]any{"status": v.Playback.Status, "track": v.Track}))
	writeJSON(w, http.StatusOK, v)
}
func (s *Server) deletePlayer(w http.ResponseWriter, r *http.Request) {
	s.store.Delete(r.PathValue("guildId"))
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) postEvent(w http.ResponseWriter, r *http.Request) {
	guildID := r.PathValue("guildId")
	var input struct {
		Type string         `json:"type"`
		Data map[string]any `json:"data"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		return
	}
	if input.Type == "" {
		writeError(w, http.StatusBadRequest, "type_required", "event type is required")
		return
	}
	e := newEvent(guildID, input.Type, input.Data)
	s.store.Publish(e)
	writeJSON(w, http.StatusAccepted, e)
}
func (s *Server) postCommand(w http.ResponseWriter, r *http.Request) {
	guildID := r.PathValue("guildId")
	var input struct {
		Name       string           `json:"name"`
		Args       map[string]any   `json:"args"`
		Issuer     *model.Requester `json:"issuer"`
		TTLSeconds int              `json:"ttlSeconds"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		return
	}
	if input.Name == "" {
		writeError(w, http.StatusBadRequest, "name_required", "command name is required")
		return
	}
	if input.TTLSeconds <= 0 || input.TTLSeconds > 300 {
		input.TTLSeconds = 30
	}
	now := time.Now().UTC()
	cmd := model.Command{ID: newID(), GuildID: guildID, Name: input.Name, IssuedAt: now, ExpiresAt: now.Add(time.Duration(input.TTLSeconds) * time.Second), Args: input.Args, Issuer: input.Issuer}
	s.store.Publish(newEvent(guildID, "command."+input.Name, map[string]any{"command": cmd}))
	writeJSON(w, http.StatusAccepted, cmd)
}
func (s *Server) ingestLavalink(w http.ResponseWriter, r *http.Request) {
	var in model.LavalinkIngest
	if err := decodeJSON(w, r, &in); err != nil {
		return
	}
	v, err := ingest.FromLavalink(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_lavalink_payload", err.Error())
		return
	}
	s.store.PutSnapshot(v)
	s.store.Publish(newEvent(v.GuildID, "player.lavalink_snapshot", map[string]any{"status": v.Playback.Status, "track": v.Track}))
	writeJSON(w, http.StatusOK, v)
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming_unavailable", "response streaming is unavailable")
		return
	}
	guildID := r.PathValue("guildId")
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	for _, event := range s.store.History(guildID) {
		writeSSE(w, event)
	}
	flusher.Flush()
	ch, cancel := s.store.Subscribe(guildID)
	defer cancel()
	keepAlive := time.NewTicker(20 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, e)
			flusher.Flush()
		case <-keepAlive.C:
			_, _ = fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}
func writeSSE(w http.ResponseWriter, event model.Event) {
	b, _ := json.Marshal(event)
	_, _ = fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n", event.ID, event.Type, b)
}
func newEvent(guildID, typ string, data map[string]any) model.Event {
	return model.Event{ID: newID(), Type: typ, GuildID: guildID, Timestamp: time.Now().UTC(), Data: data}
}
func newID() string { return strconv.FormatInt(time.Now().UnixNano(), 36) }
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 512<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return err
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message, "status": status}})
}
