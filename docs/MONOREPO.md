# Monorepo Setup

This project is a monorepo with 3 main apps which are seaparately deployed:

1. `app` - A React Native/Expo app for iOS and Android for canvassing
1. `web` - A Tanstack Start server that acts as:

- Admin interface (all actions not performed by canvassers or field leads)
- Server, doing SSR for the admin interface and serving HTTP for the mobile app
- Coordinator/orchestrator,

1. `data` - A Python project for process voter data, geocoding, and turf cutting.
