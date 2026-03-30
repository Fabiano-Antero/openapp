import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import Alexa from "ask-sdk-core";
import { ExpressAdapter } from "ask-sdk-express-adapter";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const jsonParser = express.json();

app.use(cors());
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

const PORT = Number(process.env.PORT || 8787);
const API_TOKEN = process.env.API_TOKEN || "changeme";
const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || "";
const DATA_FILE = path.resolve(__dirname, "..", process.env.DATA_FILE || "./data.json");

function ensureStore() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ devices: {}, commands: {} }, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function auth(req, res, next) {
  if (req.header("x-api-token") !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function getDefaultDeviceId() {
  if (DEFAULT_DEVICE_ID) return DEFAULT_DEVICE_ID;
  const store = readStore();
  const firstDeviceId = Object.keys(store.devices)[0] || "";
  return firstDeviceId;
}

function queueOpenSlotCommand(deviceId, slot) {
  const store = readStore();
  const device = store.devices[deviceId];

  if (!device) {
    const error = new Error("Device not found");
    error.statusCode = 404;
    throw error;
  }

  const mappedApp = device.slots?.[String(slot)];
  if (!mappedApp?.packageName) {
    const error = new Error("Slot is not configured");
    error.statusCode = 400;
    throw error;
  }

  const id = uuidv4();
  store.commands[id] = {
    id,
    deviceId,
    type: "OPEN_APP",
    slot: String(slot),
    packageName: mappedApp.packageName,
    appLabel: mappedApp.label,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  writeStore(store);

  return { commandId: id, deviceId, slot: String(slot), packageName: mappedApp.packageName, appLabel: mappedApp.label };
}

async function openDefaultSlot(slot) {
  const deviceId = getDefaultDeviceId();
  if (!deviceId) {
    const error = new Error("Nenhuma TV foi registrada ainda.");
    error.statusCode = 400;
    throw error;
  }

  return queueOpenSlotCommand(deviceId, slot);
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === "LaunchRequest";
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak("Controle TV pronto. Diga abrir app 1, 2, 3 ou 4.")
      .reprompt("Diga abrir app 1.")
      .getResponse();
  },
};

const OpenSlotIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "OpenSlotIntent"
    );
  },
  async handle(handlerInput) {
    const slot = Number(Alexa.getSlotValue(handlerInput.requestEnvelope, "slot") || 0);

    if (![1, 2, 3, 4].includes(slot)) {
      return handlerInput.responseBuilder
        .speak("Escolha um slot de 1 a 4.")
        .reprompt("Diga abrir app 1.")
        .getResponse();
    }

    try {
      const result = await openDefaultSlot(slot);
      const targetName = result.appLabel || `app ${slot}`;
      return handlerInput.responseBuilder
        .speak(`Pronto. Enviei o comando para abrir ${targetName}.`)
        .getResponse();
    } catch (error) {
      return handlerInput.responseBuilder
        .speak(`Não consegui abrir o app ${slot}. ${error.message}`)
        .getResponse();
    }
  },
};

const HelpHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === "AMAZON.HelpIntent"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak("Você pode dizer abrir app 1, 2, 3 ou 4.")
      .reprompt("Diga abrir app 1.")
      .getResponse();
  },
};

const StopHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
      ["AMAZON.CancelIntent", "AMAZON.StopIntent"].includes(Alexa.getIntentName(handlerInput.requestEnvelope))
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak("Até logo.").getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error("Alexa error:", error);
    return handlerInput.responseBuilder
      .speak("Ocorreu um erro ao processar o comando.")
      .getResponse();
  },
};

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(LaunchRequestHandler, OpenSlotIntentHandler, HelpHandler, StopHandler)
  .addErrorHandlers(ErrorHandler)
  .create();

const alexaAdapter = new ExpressAdapter(skill, true, true);

app.get("/", (_req, res) => {
  res.json({
    name: "Alexa TV Launcher Backend",
    ok: true,
    endpoints: {
      health: "/health",
      alexa: "/alexa",
    },
  });
});

app.post(
  "/alexa",
  (req, _res, next) => {
    console.log("Alexa request recebida em /alexa");
    next();
  },
  ...alexaAdapter.getRequestHandlers()
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: "webservice", defaultDeviceId: getDefaultDeviceId() || null });
});

app.post("/devices/register", jsonParser, auth, (req, res) => {
  const { deviceId, name, platform, appVersion } = req.body || {};
  if (!deviceId || !name) {
    return res.status(400).json({ error: "deviceId and name are required" });
  }

  const store = readStore();
  store.devices[deviceId] = {
    ...(store.devices[deviceId] || { slots: {}, apps: [], createdAt: new Date().toISOString() }),
    deviceId,
    name,
    platform: platform || "android",
    appVersion: appVersion || "1.0.0",
    lastSeenAt: new Date().toISOString(),
  };
  writeStore(store);
  res.json({ ok: true, device: store.devices[deviceId] });
});

app.post("/devices/:deviceId/apps", jsonParser, auth, (req, res) => {
  const store = readStore();
  const device = store.devices[req.params.deviceId];

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  device.apps = Array.isArray(req.body?.apps) ? req.body.apps : [];
  device.lastSeenAt = new Date().toISOString();
  writeStore(store);
  res.json({ ok: true });
});

app.post("/devices/:deviceId/slots", jsonParser, auth, (req, res) => {
  const store = readStore();
  const device = store.devices[req.params.deviceId];

  if (!device) {
    return res.status(404).json({ error: "Device not found" });
  }

  device.slots = req.body?.slots || {};
  device.lastSeenAt = new Date().toISOString();
  writeStore(store);
  res.json({ ok: true, slots: device.slots });
});

app.get("/devices/:deviceId/commands/next", auth, (req, res) => {
  const store = readStore();
  const command = Object.values(store.commands).find(
    (item) => item.deviceId === req.params.deviceId && item.status === "pending",
  );

  if (!command) {
    return res.json({ command: null });
  }

  command.status = "delivered";
  command.deliveredAt = new Date().toISOString();
  writeStore(store);
  res.json({ command });
});

app.post("/devices/:deviceId/commands/:commandId/ack", jsonParser, auth, (req, res) => {
  const store = readStore();
  const cmd = store.commands[req.params.commandId];

  if (!cmd) {
    return res.status(404).json({ error: "Command not found" });
  }

  cmd.status = req.body?.status || "done";
  cmd.details = req.body?.details || null;
  cmd.ackAt = new Date().toISOString();
  writeStore(store);
  res.json({ ok: true });
});

app.post("/alexa/open-slot", jsonParser, auth, (req, res) => {
  try {
    const { deviceId, slot } = req.body || {};
    const result = queueOpenSlotCommand(deviceId, slot);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Unexpected error" });
  }
});

app.post("/alexa", ...alexaAdapter.getRequestHandlers());

app.listen(PORT, () => {
  ensureStore();
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Alexa endpoint available at /alexa`);
  if (!DEFAULT_DEVICE_ID) {
    console.log("DEFAULT_DEVICE_ID is empty. The first registered device will be used for the skill.");
  }
});
