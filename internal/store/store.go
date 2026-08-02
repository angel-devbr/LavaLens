package store

import (
	"errors"
	"sync"
	"time"

	"github.com/example/lavalens/internal/model"
)

var ErrNotFound = errors.New("not found")

type Store struct {
	mu          sync.RWMutex
	snapshots   map[string]model.Snapshot
	history     map[string][]model.Event
	subscribers map[string]map[chan model.Event]struct{}
	maxHistory  int
	ttl         time.Duration
}

func New(maxHistory int, ttl time.Duration) *Store {
	if maxHistory < 1 {
		maxHistory = 16
	}
	return &Store{snapshots: make(map[string]model.Snapshot), history: make(map[string][]model.Event), subscribers: make(map[string]map[chan model.Event]struct{}), maxHistory: maxHistory, ttl: ttl}
}
func (s *Store) PutSnapshot(v model.Snapshot) { s.mu.Lock(); s.snapshots[v.GuildID] = v; s.mu.Unlock() }
func (s *Store) Snapshot(guildID string) (model.Snapshot, error) {
	s.mu.RLock()
	v, ok := s.snapshots[guildID]
	s.mu.RUnlock()
	if !ok {
		return model.Snapshot{}, ErrNotFound
	}
	return v, nil
}
func (s *Store) ListSnapshots() []model.Snapshot {
	s.mu.RLock()
	out := make([]model.Snapshot, 0, len(s.snapshots))
	for _, v := range s.snapshots {
		out = append(out, v)
	}
	s.mu.RUnlock()
	return out
}
func (s *Store) Delete(guildID string) {
	s.mu.Lock()
	delete(s.snapshots, guildID)
	delete(s.history, guildID)
	s.mu.Unlock()
}
func (s *Store) Publish(event model.Event) {
	s.mu.Lock()
	h := append(s.history[event.GuildID], event)
	if len(h) > s.maxHistory {
		h = h[len(h)-s.maxHistory:]
	}
	s.history[event.GuildID] = h
	for ch := range s.subscribers[event.GuildID] {
		select {
		case ch <- event:
		default:
		}
	}
	s.mu.Unlock()
}
func (s *Store) History(guildID string) []model.Event {
	s.mu.RLock()
	h := append([]model.Event(nil), s.history[guildID]...)
	s.mu.RUnlock()
	return h
}
func (s *Store) Subscribe(guildID string) (<-chan model.Event, func()) {
	ch := make(chan model.Event, 32)
	s.mu.Lock()
	if s.subscribers[guildID] == nil {
		s.subscribers[guildID] = make(map[chan model.Event]struct{})
	}
	s.subscribers[guildID][ch] = struct{}{}
	s.mu.Unlock()
	cancel := func() {
		s.mu.Lock()
		if set := s.subscribers[guildID]; set != nil {
			if _, ok := set[ch]; ok {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(s.subscribers, guildID)
			}
		}
		s.mu.Unlock()
	}
	return ch, cancel
}
func (s *Store) Counts() (guilds, subscribers int) {
	s.mu.RLock()
	guilds = len(s.snapshots)
	for _, set := range s.subscribers {
		subscribers += len(set)
	}
	s.mu.RUnlock()
	return
}
func (s *Store) Cleanup(now time.Time) int {
	if s.ttl <= 0 {
		return 0
	}
	removed := 0
	s.mu.Lock()
	for guildID, v := range s.snapshots {
		if now.Sub(v.UpdatedAt) > s.ttl {
			delete(s.snapshots, guildID)
			delete(s.history, guildID)
			removed++
		}
	}
	s.mu.Unlock()
	return removed
}
