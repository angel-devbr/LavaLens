package ingest

import (
	"github.com/example/lavalens/internal/model"
	"testing"
)

func TestFromLavalink(t *testing.T) {
	var in model.LavalinkIngest
	in.Player.GuildID = "123"
	in.Player.Volume = 80
	in.Player.State.Connected = true
	in.Player.State.Position = 5000
	in.Player.Voice.ChannelID = "456"
	in.Player.Track = &model.LavalinkTrack{}
	in.Player.Track.Info.Identifier = "abc"
	in.Player.Track.Info.Title = "Track"
	in.Player.Track.Info.Author = "Artist"
	in.Player.Track.Info.SourceName = "youtube"
	in.Player.Track.Info.Length = 60000
	s, err := FromLavalink(in)
	if err != nil {
		t.Fatal(err)
	}
	if s.Playback.Status != "playing" || s.Track == nil || s.Track.Title != "Track" {
		t.Fatalf("unexpected snapshot: %#v", s)
	}
	if s.Audio.Codec != "opus" || s.Audio.SampleRateHz != 48000 {
		t.Fatalf("unexpected audio defaults: %#v", s.Audio)
	}
}
