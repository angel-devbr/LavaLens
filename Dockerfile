FROM golang:1.23-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/lavalens ./cmd/lavalens
FROM scratch
COPY --from=build /out/lavalens /lavalens
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/lavalens"]
