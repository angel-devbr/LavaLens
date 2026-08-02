package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/example/lavalens/internal/httpapi"
	"github.com/example/lavalens/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	port := env("PORT", "8080")
	token := os.Getenv("LAVALENS_TOKEN")
	ttl := durationEnv("STATE_TTL", 30*time.Minute)
	st := store.New(intEnv("EVENT_HISTORY", 16), ttl)
	srv := &http.Server{Addr: ":" + port, Handler: httpapi.New(st, token, logger), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 70 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if removed := st.Cleanup(now); removed > 0 {
					logger.Info("expired player states removed", "count", removed)
				}
			}
		}
	}()
	go func() {
		logger.Info("lavalens started", "port", port, "stateTTL", ttl.String(), "authEnabled", token != "")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	logger.Info("lavalens stopped")
}
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
func intEnv(key string, def int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil || v <= 0 {
		return def
	}
	return v
}
func durationEnv(key string, def time.Duration) time.Duration {
	v, err := time.ParseDuration(os.Getenv(key))
	if err != nil || v <= 0 {
		return def
	}
	return v
}
