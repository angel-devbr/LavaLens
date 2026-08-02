package model

import "time"

const APIVersion = "2026-08-02"

type Snapshot struct {
	APIVersion string         `json:"apiVersion"`
	GuildID    string         `json:"guildId"`
	BotID      string         `json:"botId,omitempty"`
	UpdatedAt  time.Time      `json:"updatedAt"`
	Playback   Playback       `json:"playback"`
	Track      *Track         `json:"track,omitempty"`
	Playlist   *Playlist      `json:"playlist,omitempty"`
	Queue      Queue          `json:"queue"`
	Node       Node           `json:"node"`
	Discord    Discord        `json:"discord"`
	Audio      Audio          `json:"audio"`
	Request    *Requester     `json:"request,omitempty"`
	Extensions map[string]any `json:"extensions,omitempty"`
}

type Playback struct {
	Status     string     `json:"status"`
	PositionMS int64      `json:"positionMs"`
	DurationMS int64      `json:"durationMs"`
	Volume     int        `json:"volume"`
	RepeatMode string     `json:"repeatMode,omitempty"`
	Autoplay   bool       `json:"autoplay"`
	Filters    []string   `json:"filters,omitempty"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	PausedAt   *time.Time `json:"pausedAt,omitempty"`
}

type Track struct {
	Encoded      string         `json:"encoded,omitempty"`
	Identifier   string         `json:"identifier"`
	Title        string         `json:"title"`
	Author       string         `json:"author"`
	URI          string         `json:"uri,omitempty"`
	ArtworkURL   string         `json:"artworkUrl,omitempty"`
	SourceName   string         `json:"sourceName"`
	ISRC         string         `json:"isrc,omitempty"`
	Album        string         `json:"album,omitempty"`
	AlbumArtwork string         `json:"albumArtworkUrl,omitempty"`
	IsStream     bool           `json:"isStream"`
	IsSeekable   bool           `json:"isSeekable"`
	PluginInfo   map[string]any `json:"pluginInfo,omitempty"`
	UserData     map[string]any `json:"userData,omitempty"`
}

type Playlist struct {
	ID           string         `json:"id,omitempty"`
	Name         string         `json:"name"`
	URI          string         `json:"uri,omitempty"`
	ArtworkURL   string         `json:"artworkUrl,omitempty"`
	SourceName   string         `json:"sourceName,omitempty"`
	OwnerName    string         `json:"ownerName,omitempty"`
	OwnerURL     string         `json:"ownerUrl,omitempty"`
	CurrentIndex int            `json:"currentIndex"`
	TotalTracks  int            `json:"totalTracks"`
	PluginInfo   map[string]any `json:"pluginInfo,omitempty"`
}

type Queue struct {
	Size         int    `json:"size"`
	CurrentIndex int    `json:"currentIndex"`
	NextTitle    string `json:"nextTitle,omitempty"`
	NextURI      string `json:"nextUri,omitempty"`
}

type Node struct {
	ID             string  `json:"id"`
	Region         string  `json:"region,omitempty"`
	Engine         string  `json:"engine"`
	Version        string  `json:"version,omitempty"`
	UptimeMS       int64   `json:"uptimeMs"`
	Players        int     `json:"players"`
	PlayingPlayers int     `json:"playingPlayers"`
	CPUPercent     float64 `json:"cpuPercent"`
	MemoryUsed     int64   `json:"memoryUsedBytes"`
	MemoryLimit    int64   `json:"memoryLimitBytes,omitempty"`
	PingMS         int64   `json:"pingMs"`
	FramesSent     int64   `json:"framesSent,omitempty"`
	FramesLost     int64   `json:"framesLost,omitempty"`
	FramesDeficit  int64   `json:"framesDeficit,omitempty"`
}

type Discord struct {
	GuildID     string `json:"guildId"`
	ChannelID   string `json:"channelId,omitempty"`
	ChannelName string `json:"channelName,omitempty"`
	Connected   bool   `json:"connected"`
	Listeners   int    `json:"listeners"`
	VoiceRegion string `json:"voiceRegion,omitempty"`
	VoicePingMS int64  `json:"voicePingMs"`
	SessionID   string `json:"sessionId,omitempty"`
	ShardID     int    `json:"shardId,omitempty"`
}

type Audio struct {
	Codec             string  `json:"codec"`
	SampleRateHz      int     `json:"sampleRateHz"`
	Channels          int     `json:"channels"`
	BitrateKbps       int     `json:"bitrateKbps"`
	BufferMS          int     `json:"bufferMs"`
	PacketLossPercent float64 `json:"packetLossPercent"`
	Transcoding       bool    `json:"transcoding"`
	Normalization     bool    `json:"normalization"`
}

type Requester struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	Locale      string `json:"locale,omitempty"`
}

type Event struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	GuildID   string         `json:"guildId"`
	Timestamp time.Time      `json:"timestamp"`
	Data      map[string]any `json:"data,omitempty"`
}

type Command struct {
	ID        string         `json:"id"`
	GuildID   string         `json:"guildId"`
	Name      string         `json:"name"`
	IssuedAt  time.Time      `json:"issuedAt"`
	ExpiresAt time.Time      `json:"expiresAt"`
	Args      map[string]any `json:"args,omitempty"`
	Issuer    *Requester     `json:"issuer,omitempty"`
}

type LavalinkIngest struct {
	SessionID string         `json:"sessionId"`
	BotID     string         `json:"botId,omitempty"`
	Player    LavalinkPlayer `json:"player"`
	Context   IngestContext  `json:"context"`
	Node      *LavalinkStats `json:"node,omitempty"`
}

type IngestContext struct {
	Playlist    *Playlist      `json:"playlist,omitempty"`
	Queue       Queue          `json:"queue"`
	Request     *Requester     `json:"request,omitempty"`
	ChannelName string         `json:"channelName,omitempty"`
	Listeners   int            `json:"listeners,omitempty"`
	Region      string         `json:"region,omitempty"`
	NodeID      string         `json:"nodeId,omitempty"`
	NodeVersion string         `json:"nodeVersion,omitempty"`
	Audio       *Audio         `json:"audio,omitempty"`
	Extensions  map[string]any `json:"extensions,omitempty"`
}

type LavalinkPlayer struct {
	GuildID string         `json:"guildId"`
	Track   *LavalinkTrack `json:"track,omitempty"`
	Volume  int            `json:"volume"`
	Paused  bool           `json:"paused"`
	State   struct {
		Time      int64 `json:"time"`
		Position  int64 `json:"position"`
		Connected bool  `json:"connected"`
		Ping      int64 `json:"ping"`
	} `json:"state"`
	Voice struct {
		SessionID string `json:"sessionId"`
		ChannelID string `json:"channelId"`
	} `json:"voice"`
	Filters map[string]any `json:"filters,omitempty"`
}

type LavalinkTrack struct {
	Encoded string `json:"encoded,omitempty"`
	Info    struct {
		Identifier string  `json:"identifier"`
		IsSeekable bool    `json:"isSeekable"`
		Author     string  `json:"author"`
		Length     int64   `json:"length"`
		IsStream   bool    `json:"isStream"`
		Position   int64   `json:"position"`
		Title      string  `json:"title"`
		URI        *string `json:"uri"`
		ArtworkURL *string `json:"artworkUrl"`
		ISRC       *string `json:"isrc"`
		SourceName string  `json:"sourceName"`
	} `json:"info"`
	PluginInfo map[string]any `json:"pluginInfo,omitempty"`
	UserData   map[string]any `json:"userData,omitempty"`
}

type LavalinkStats struct {
	Players        int   `json:"players"`
	PlayingPlayers int   `json:"playingPlayers"`
	Uptime         int64 `json:"uptime"`
	Memory         struct {
		Used       int64 `json:"used"`
		Reservable int64 `json:"reservable"`
	} `json:"memory"`
	CPU struct {
		LavalinkLoad float64 `json:"lavalinkLoad"`
	} `json:"cpu"`
	FrameStats *struct {
		Sent    int64 `json:"sent"`
		Deficit int64 `json:"deficit"`
		Nulled  int64 `json:"nulled"`
	} `json:"frameStats,omitempty"`
}
