import json, os, urllib.request
base_url=os.getenv("LAVALENS_URL","http://localhost:8080"); token=os.getenv("LAVALENS_TOKEN","change-this-token"); guild_id=os.getenv("DISCORD_GUILD_ID","1234567890")
request=urllib.request.Request(f"{base_url}/v1/guilds/{guild_id}/player",headers={"Authorization":f"Bearer {token}"})
with urllib.request.urlopen(request,timeout=10) as response: state=json.load(response)
print(json.dumps({"tocando":state["playback"]["status"]=="playing","musica":(state.get("track")or{}).get("title"),"plataforma":(state.get("track")or{}).get("sourceName"),"foto":(state.get("track")or{}).get("artworkUrl"),"playlist":(state.get("playlist")or{}).get("name"),"foto_da_playlist":(state.get("playlist")or{}).get("artworkUrl")},ensure_ascii=False,indent=2))
