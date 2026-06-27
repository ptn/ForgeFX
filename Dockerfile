# syntax=docker/dockerfile:1
#
# Multi-stage build for ForgeFX.Server. The Microsoft .NET images are multi-arch,
# so this builds natively on amd64 and arm64 (Raspberry Pi 4/5).
#
#   docker build -t forgefx .                 # build the runtime image
#   docker build --target test -t fx:test .   # build + run the test suite (CI)

ARG DOTNET=10.0

# ---- restore + build the whole solution ----
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET} AS build
WORKDIR /src
COPY . .
RUN dotnet restore
RUN dotnet build -c Release --no-restore

# ---- run the test suite (CI targets this stage; a failure fails the build) ----
FROM build AS test
RUN dotnet test -c Release --no-build --verbosity normal

# ---- publish the server ----
FROM build AS publish
RUN dotnet publish src/ForgeFX.Server -c Release -o /app

# ---- minimal runtime image ----
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET} AS runtime
WORKDIR /app
COPY --from=publish /app ./
# definition packs are loaded at runtime and are not part of the publish output
COPY definitions ./definitions
# listen on all interfaces inside the container; map a host port in compose
ENV ASPNETCORE_URLS=http://0.0.0.0:5056
EXPOSE 5056
# device path is passed as an arg by compose (e.g. --device /dev/fm3); without it
# the server auto-detects a mapped /dev/ttyACM* port.
ENTRYPOINT ["dotnet", "ForgeFX.Server.dll"]
