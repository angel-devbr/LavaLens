package ingest

import (
	"fmt"
	"sort"
	"time"

	"github.com/example/lavalens/internal/model"
)

func FromLavalink(in model.LavalinkIngest) (model.Snapshot, error) {
	if in.Player.GuildID == "" {
		return model.Snapshot{}, fmt.Errorf("player.guildId is required")
	}
	status := "idle"
	if in.Player.Track != nil {
		status = "playing"
		if in.Player.Paused {
			status = "paused"
		} else if !in.Player.State.Connected {
			status = "reconnecting"
		}
	}
	s := model.Snapshot{
		APIVersion: model.APIVersion,
		GuildID:    in.Player.GuildID,
		BotID:      in.BotID,
		UpdatedAt:  time.Now().UTC(),
		Playback: model.Playback{
			Status:     status,
			PositionMS: in.Player.State.Position,
			Volume:     in.Player.Volume,
			Filters:    filterNames(in.Player.Filters),
		},
		Playlist: in.Context.Playlist,
		Queue:    in.Context.Queue,
		Node: model.Node{
			ID:      fallback(in.Context.NodeID, "lavalink"),
			Region:  in.Context.Region,
			Engine:  "lavalink-v4",
			Version: in.Context.NodeVersion,
			PingMS:  in.Player.State.Ping,
		},
		Discord: model.Discord{
			GuildID:     in.Player.GuildID,
			ChannelID:   in.Player.Voice.ChannelID,
			ChannelName: in.Context.ChannelName,
			Connected:   in.Player.State.Connected,
			Listeners:   in.Context.Listeners,
			VoicePingMS: in.Player.State.Ping,
			SessionID:   in.Player.Voice.SessionID,
		},
		Audio:      model.Audio{Codec: "opus", SampleRateHz: 48000, Channels: 2, BitrateKbps: 128, BufferMS: 400},
		Request:    in.Context.Request,
		Extensions: in.Context.Extensions,
	}
	if in.Context.Audio != nil {
		s.Audio = *in.Context.Audio
	}
	if in.Player.Track != nil {
		t := in.Player.Track
		s.Playback.DurationMS = t.Info.Length
		s.Track = &model.Track{
			Encoded: t.Encoded, Identifier: t.Info.Identifier, Title: t.Info.Title, Author: t.Info.Author,
			URI: deref(t.Info.URI), ArtworkURL: deref(t.Info.ArtworkURL), SourceName: t.Info.SourceName,
			ISRC: deref(t.Info.ISRC), IsStream: t.Info.IsStream, IsSeekable: t.Info.IsSeekable,
			PluginInfo: t.PluginInfo, UserData: t.UserData,
		}
	}
	if in.Node != nil {
		s.Node.Players = in.Node.Players
		s.Node.PlayingPlayers = in.Node.PlayingPlayers
		s.Node.UptimeMS = in.Node.Uptime
		s.Node.MemoryUsed = in.Node.Memory.Used
		s.Node.MemoryLimit = in.Node.Memory.Reservable
		s.Node.CPUPercent = in.Node.CPU.LavalinkLoad * 100
		if in.Node.FrameStats != nil {
			s.Node.FramesSent = in.Node.FrameStats.Sent
			s.Node.FramesDeficit = in.Node.FrameStats.Deficit
			s.Node.FramesLost = in.Node.FrameStats.Nulled
		}
	}
	return s, nil
}

func filterNames(filters map[string]any) []string {
	if len(filters) == 0 {
		return nil
	}
	out := make([]string, 0, len(filters))
	for k, v := range filters {
		if v != nil {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}
func deref(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}
func fallback(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
