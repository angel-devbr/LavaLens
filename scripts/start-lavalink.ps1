$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:YOUTUBE_OAUTH_REFRESH_TOKEN)) {
    Write-Error "YOUTUBE_OAUTH_REFRESH_TOKEN é obrigatório. Gere o token com application-oauth-setup.yml e tente novamente."
    exit 78
}

$jar = if ($env:LAVALINK_JAR) { $env:LAVALINK_JAR } else { "Lavalink.jar" }
& java -jar $jar
exit $LASTEXITCODE
