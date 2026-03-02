/**
 * Lahuen CRM — Backend (Google Apps Script)
 * Cooperativa Lahuen — CRM de prospectos gastronómicos
 *
 * Basado en la arquitectura de miMercadito.
 * Google Sheets como base de datos, dual-mode frontend (GAS + GitHub Pages).
 */

const GLOBAL_ENV = {
  SPREADSHEET_ID: 'REPLACE_WITH_SPREADSHEET_ID',
  API_TOKEN: 'REPLACE_WITH_API_TOKEN',
  AUTHORIZED_EMAILS: 'REPLACE_WITH_EMAILS'
};

function getSettings() {
  const p = PropertiesService.getScriptProperties().getProperties();

  const get = (key: keyof typeof GLOBAL_ENV) => {
    const val = GLOBAL_ENV[key];
    if (val && !val.includes('REPLACE_WITH')) return val;
    return p[key] || "";
  };

  return {
    SPREADSHEET_ID: get("SPREADSHEET_ID"),
    API_TOKEN: get("API_TOKEN") || "default_token",
    AUTHORIZED_EMAILS: (get("AUTHORIZED_EMAILS") || "").split(",").map(e => e.trim())
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProspectPayload {
  local?: string;
  contacto?: string;
  whatsapp?: string;
  perfil?: string;
  zona?: string;
  segmento?: string;
  direccion?: string;
  resultado?: string;
  fechaVisita?: string;
  fechaSeguimiento?: string;
  productosInteres?: string;
  notas?: string;
  vendedor?: string;
  rowIndex?: number;
}

const COL = {
  FECHA_CREACION: 0,
  LOCAL: 1,
  CONTACTO: 2,
  WHATSAPP: 3,
  PERFIL: 4,
  ZONA: 5,
  SEGMENTO: 6,
  DIRECCION: 7,
  RESULTADO: 8,
  FECHA_VISITA: 9,
  FECHA_SEGUIMIENTO: 10,
  PRODUCTOS_INTERES: 11,
  NOTAS: 12,
  VENDEDOR: 13,
} as const;

type ProspectRow = string[];
type ProspectData = ProspectRow[];

/**
 * ONE-TIME SETUP: Run in the Apps Script Editor to set secrets.
 */
function setupSecrets() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    "SPREADSHEET_ID": "PONER_ACA_ID_DEL_SHEET",
    "AUTHORIZED_EMAILS": "cbd.preparados@gmail.com,gmedina86@gmail.com,fefox911@gmail.com,lahuencoop@gmail.com,rodrigocbdthc@gmail.com,walter.medina.pourcel@gmail.com",
    "API_TOKEN": "un_token_seguro_y_largo_aca"
  });
  Logger.log("Secretos configurados.");
}

// ── Entry points ──────────────────────────────────────────────────────────────

function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput | GoogleAppsScript.Content.TextOutput {
  try {
    const action = e.parameter["action"];
    if (action) return handleApiRequest(e);

    const config = getSettings();
    const page = e.parameter["p"] || "index";
    const userEmail = Session.getActiveUser().getEmail();
    const isAuthorized = config.AUTHORIZED_EMAILS.indexOf(userEmail) !== -1 || userEmail === "";

    if (!isAuthorized) return HtmlService.createHtmlOutput("<h2>Acceso denegado</h2><p>Tu email no tiene permisos para usar esta aplicación.</p>");

    const template = HtmlService.createTemplateFromFile(page);
    return template
      .evaluate()
      .setTitle("Lahuen CRM")
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    if (e.parameter["action"]) return createJsonResponse({ error: "CRITICAL_GET_ERROR: " + String(err) });
    return HtmlService.createHtmlOutput("<h2>Error</h2><p>" + err + "</p>");
  }
}

function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    return handleApiRequest(e);
  } catch (err) {
    return createJsonResponse({ error: "CRITICAL_POST_ERROR: " + String(err) });
  }
}

function handleApiRequest(e: any): GoogleAppsScript.Content.TextOutput {
  let config: any;
  try {
    config = getSettings();
  } catch (err) {
    return createJsonResponse({ error: "SETTINGS_ERROR: " + String(err) });
  }

  const params = e.parameter || {};
  let postData: any = {};
  if (e.postData && e.postData.contents) {
    try {
      postData = JSON.parse(e.postData.contents);
    } catch (_) { /* ignore parse errors */ }
  }

  const action = (params["action"] || postData.action || "").trim();
  const token = (params["token"] || postData.token || "").trim();
  const payload = (e.postData && e.postData.contents) ? postData : params;

  // googleAuth does not require API token — it validates via Google ID token
  if (action === "googleAuth") {
    const credential = params["credential"] || postData.credential || "";
    return createJsonResponse(verifyGoogleAuth(credential));
  }

  if (!token || token !== config.API_TOKEN.trim()) {
    return createJsonResponse({ error: "Unauthorized: Invalid API Token." });
  }

  try {
    let result: any;
    switch (action) {
      case "getData":         result = getProspectData(); break;
      case "addProspect":     result = addProspect(payload); break;
      case "updateProspect":  result = updateProspect(payload); break;
      case "archiveProspect": result = archiveProspect(Number(payload.rowIndex)); break;
      default: result = { error: "Action '" + action + "' not found" };
    }
    return createJsonResponse(result);
  } catch (err) {
    return createJsonResponse({ error: "EXECUTION_ERROR: " + String(err) });
  }
}

function createJsonResponse(data: any): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function include(filename: string): string {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getScriptUrl(): string {
  return ScriptApp.getService().getUrl();
}

// ── Data Read ─────────────────────────────────────────────────────────────────

function getProspectData(): ProspectData | string {
  try {
    const config = getSettings();
    const id = (config.SPREADSHEET_ID || "").trim();

    if (!id || id.includes("PONER_ACA")) {
      return "Error: SPREADSHEET_ID no configurado. Ejecuta setupSecrets.";
    }

    const ss = SpreadsheetApp.openById(id);
    const sheet = ss.getSheetByName("Prospectos") ?? ss.getSheets()[0];
    const values = sheet.getDataRange().getValues();

    if (values.length <= 1) return [];

    const cleanData: ProspectData = values.slice(1).map((row) =>
      row.map((cell) => String(cell))
    );

    return cleanData;
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

// ── Data Write ────────────────────────────────────────────────────────────────

function addProspect(payload: ProspectPayload): string {
  try {
    const config = getSettings();
    const ss = SpreadsheetApp.openById(config.SPREADSHEET_ID);
    const sheet = ss.getSheetByName("Prospectos") ?? ss.getSheets()[0];

    sheet.appendRow([
      new Date(),                              // FECHA_CREACION
      payload.local || "",                     // LOCAL
      payload.contacto || "",                  // CONTACTO
      payload.whatsapp || "",                  // WHATSAPP
      payload.perfil || "",                    // PERFIL
      payload.zona || "",                      // ZONA
      payload.segmento || "",                  // SEGMENTO
      payload.direccion || "",                 // DIRECCION
      payload.resultado || "pendiente",        // RESULTADO
      payload.fechaVisita || "",               // FECHA_VISITA
      payload.fechaSeguimiento || "",          // FECHA_SEGUIMIENTO
      payload.productosInteres || "",          // PRODUCTOS_INTERES
      payload.notas || "",                     // NOTAS
      payload.vendedor || "",                  // VENDEDOR
    ]);

    return "Prospecto guardado.";
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

function updateProspect(payload: ProspectPayload): string {
  try {
    const config = getSettings();
    if (!payload.rowIndex) throw new Error("Missing rowIndex for update.");

    const ss = SpreadsheetApp.openById(config.SPREADSHEET_ID);
    const sheet = ss.getSheetByName("Prospectos") ?? ss.getSheets()[0];
    const row = payload.rowIndex;

    if (payload.local !== undefined)             sheet.getRange(row, COL.LOCAL + 1).setValue(payload.local);
    if (payload.contacto !== undefined)          sheet.getRange(row, COL.CONTACTO + 1).setValue(payload.contacto);
    if (payload.whatsapp !== undefined)          sheet.getRange(row, COL.WHATSAPP + 1).setValue(payload.whatsapp);
    if (payload.perfil !== undefined)            sheet.getRange(row, COL.PERFIL + 1).setValue(payload.perfil);
    if (payload.zona !== undefined)              sheet.getRange(row, COL.ZONA + 1).setValue(payload.zona);
    if (payload.segmento !== undefined)          sheet.getRange(row, COL.SEGMENTO + 1).setValue(payload.segmento);
    if (payload.direccion !== undefined)         sheet.getRange(row, COL.DIRECCION + 1).setValue(payload.direccion);
    if (payload.resultado !== undefined)         sheet.getRange(row, COL.RESULTADO + 1).setValue(payload.resultado);
    if (payload.fechaVisita !== undefined)       sheet.getRange(row, COL.FECHA_VISITA + 1).setValue(payload.fechaVisita);
    if (payload.fechaSeguimiento !== undefined)  sheet.getRange(row, COL.FECHA_SEGUIMIENTO + 1).setValue(payload.fechaSeguimiento);
    if (payload.productosInteres !== undefined)  sheet.getRange(row, COL.PRODUCTOS_INTERES + 1).setValue(payload.productosInteres);
    if (payload.notas !== undefined)             sheet.getRange(row, COL.NOTAS + 1).setValue(payload.notas);
    if (payload.vendedor !== undefined)          sheet.getRange(row, COL.VENDEDOR + 1).setValue(payload.vendedor);

    return "Prospecto actualizado.";
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}

// ── Google Auth ───────────────────────────────────────────────────────────────

function verifyGoogleAuth(credential: string): any {
  try {
    if (!credential) {
      return { authorized: false, error: "No se recibió credencial de Google." };
    }

    const config = getSettings();

    // Decode JWT payload (header.payload.signature)
    const parts = credential.split(".");
    if (parts.length !== 3) {
      return { authorized: false, error: "Token inválido." };
    }

    const decoded = Utilities.newBlob(
      Utilities.base64DecodeWebSafe(parts[1])
    ).getDataAsString();
    const tokenPayload = JSON.parse(decoded);

    const email = (tokenPayload.email || "").toLowerCase().trim();

    if (!tokenPayload.email_verified) {
      return { authorized: false, error: "Email no verificado." };
    }

    // Check token expiry
    const now = Math.floor(Date.now() / 1000);
    if (tokenPayload.exp && tokenPayload.exp < now) {
      return { authorized: false, error: "Token expirado." };
    }

    const authorized = config.AUTHORIZED_EMAILS.some(
      (e: string) => e.toLowerCase().trim() === email
    );

    if (!authorized) {
      return { authorized: false, error: "Tu email (" + email + ") no tiene permisos para acceder." };
    }

    return { authorized: true, email: email, token: config.API_TOKEN };
  } catch (err) {
    return { authorized: false, error: "Error verificando credenciales: " + String(err) };
  }
}

function archiveProspect(rowIndex: number): string {
  try {
    const config = getSettings();
    const ss = SpreadsheetApp.openById(config.SPREADSHEET_ID);
    const sheet = ss.getSheetByName("Prospectos") ?? ss.getSheets()[0];
    sheet.getRange(rowIndex, COL.RESULTADO + 1).setValue("no_interesado");
    return "Prospecto archivado.";
  } catch (err) {
    return `Error: ${String(err)}`;
  }
}
