#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>

// ---- USER CONFIG ----
// WiFi credentials (STA mode)
static const char* WIFI_SSID   = "portmodel";
static const char* WIFI_PASS   = "portmodel123";

// MQTT broker location
static const char* MQTT_HOST   = "192.168.1.2";
static const uint16_t MQTT_PORT = 1883;

// Logical crane identity; used to build topic names
static const char* CRANE_ID    = "crane-1";

// Serial baudrate to match Marlin firmware
static const uint32_t BAUD     = 115200;
// ---------------------

WiFiClient espClient;        // TCP socket for MQTT
PubSubClient mqtt(espClient); // MQTT client bound to the TCP socket

// Topic strings are computed once in setupTopics()
String tCmd, tResp, tLwt;

// UART line buffering for Marlin -> MQTT bridge
static const size_t LINE_BUF = 256;
char   lineBuf[LINE_BUF];
size_t lineLen = 0;

/**
 * publish(topic, payload, retain)
 * Wrapper around PubSubClient::publish().
 * NOTE: PubSubClient on ESP8266 supports retain but not QoS>0 for publish.
 * The 'qos' parameter is not used by PubSubClient and is kept here only
 * for readability / future library swaps.
 */
void publish(const String& topic, const String& payload, bool retain=false, int /*qos*/=1) {
  mqtt.publish(topic.c_str(), payload.c_str(), retain);
}

/**
 * ensureWifi()
 * Makes sure we are connected to WiFi. If not, try to connect.
 * Blocks until connected (with a simple timeout for safety).
 */
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  // Wait for WL_CONNECTED with basic timeout to avoid hard lock
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    if (millis() - start > 20000UL) break; // ~20s guard
  }
}

/**
 * onMqtt()
 * MQTT message handler. We only act on the "cmd" topic for this crane.
 * Incoming payload is forwarded raw to Marlin over UART.
 * A trailing newline is ensured so Marlin reads the full command.
 */
void onMqtt(char* topic, byte* payload, unsigned int length) {
  String t = String(topic);
  if (t != tCmd) return;  // ignore other topics

  // Forward raw bytes to UART
  for (unsigned int i = 0; i < length; i++) {
    Serial.write(payload[i]);
  }

  // Ensure newline termination for G-code if sender omitted it
  if (length == 0 || payload[length - 1] != '\n') {
    Serial.write('\n');
  }
}

/**
 * ensureMqtt()
 * Connects/reconnects to the MQTT broker.
 * Sets LWT (last will) to mark this crane offline if the client drops.
 * On successful connect, publishes "online": true and subscribes to /cmd.
 */
void ensureMqtt() {
  if (mqtt.connected()) return;

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);

  // Unique-ish client ID: <CRANE_ID>-<chipid>
  String clientId = String(CRANE_ID) + "-" + String(ESP.getChipId(), HEX);

  // Topics must exist before connect() because we reference tLwt below
  // (setupTopics() guarantees that in setup())
  String lwtMsg = String("{\"online\":false,\"id\":\"") + CRANE_ID + "\"}";

  // Attempt connect with LWT on tLwt, retained so dashboards can see state
  // connect(clientID, willTopic, willQos, willRetain, willMessage)
  if (mqtt.connect(clientId.c_str(), nullptr, nullptr,
                   tLwt.c_str(), 1, true, lwtMsg.c_str())) {

    // Announce we're online (retained) and subscribe to command topic
    publish(tLwt, String("{\"online\":true,\"id\":\"") + CRANE_ID + "\"}", /*retain=*/true);
    mqtt.subscribe(tCmd.c_str(), 1);
  }
}

/**
 * setupTopics()
 * Build topic strings once based on CRANE_ID:
 *   crane/<id>/cmd   : incoming commands -> UART
 *   crane/<id>/resp  : UART lines -> MQTT
 *   crane/<id>/lwt   : online/offline state (retained)
 */
void setupTopics() {
  String base = String("crane/") + CRANE_ID;
  tCmd  = base + "/cmd";
  tResp = base + "/resp";
  tLwt  = base + "/lwt";
}

void setup() {
  // Start UART toward Marlin
  Serial.begin(BAUD);
  delay(100);

  setupTopics();  // prepare MQTT topic strings
  ensureWifi();   // join WiFi
  // Optional: tune MQTT internal buffer to fit your largest line
  // mqtt.setBufferSize(512);

  ensureMqtt();   // connect to broker and subscribe to /cmd
}

void loop() {
  // Keep network sessions healthy and process MQTT I/O
  ensureWifi();
  ensureMqtt();
  mqtt.loop();    // non-blocking MQTT client pump

  // ---- UART -> MQTT bridge ----
  // Read bytes from Marlin, normalize CRLF to '\n',
  // accumulate into a line buffer, and publish each full line.
  while (Serial.available()) {
    char c = (char)Serial.read();

    if (c == '\r') continue;       // drop CR, treat CRLF as LF
    if (c == '\n') {
      // End of line: publish if there's content
      if (lineLen > 0) {
        lineBuf[lineLen] = '\0';
        publish(tResp, String(lineBuf));  // not retained
        lineLen = 0;                      // reset for next line
      }
    } else {
      // Append to buffer if space remains (leave room for '\0')
      if (lineLen < LINE_BUF - 1) {
        lineBuf[lineLen++] = c;
      }
      // Else: line too long—silently truncate. (Optionally detect & flush.)
    }
  }
}
