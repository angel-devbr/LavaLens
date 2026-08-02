import os, requests
BASE = os.getenv("LAVALENS_URL", "http://localhost:8080")
TOKEN = os.environ["LAVALENS_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def state(guild_id: str):
    return requests.get(f"{BASE}/v1/guilds/{guild_id}/player", headers=HEADERS).json()

def play(guild_id: str, query: str):
    return requests.post(f"{BASE}/v1/guilds/{guild_id}/play", headers=HEADERS, json={"query": query}).json()
