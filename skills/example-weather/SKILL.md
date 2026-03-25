---
name: weather-lookup
description: Get current weather for any city worldwide
version: 1.0.0
trigger: /weather
tools:
  - http_get
permissions:
  - network:outbound
env:
  - OPENWEATHER_API_KEY
---

# Weather Lookup

When the user asks about weather:

1. Extract the city name from their message
2. Use http_get to call `https://api.openweathermap.org/data/2.5/weather?q={city}&appid={OPENWEATHER_API_KEY}&units=metric`
3. Parse the JSON response
4. Format a friendly response with:
   - Current temperature
   - Weather conditions (e.g., clear, cloudy, rain)
   - Humidity percentage
   - Wind speed
