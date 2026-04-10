'use strict'

//-------------

require('dotenv').config();

//--
const express = require('express');
const bodyParser = require('body-parser')
const app = express();
require('express-ws')(app);

app.use(bodyParser.json());

const webSocket = require('ws');
const axios = require('axios');
const fsp = require('fs').promises;
const moment = require('moment');

//---- CORS policy - Update this section as needed ----

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "OPTIONS,GET,POST,PUT,DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");
  next();
});

//--- Audio silence payload for linear 16-bit, 16 kHz, mono ---
const hexSilencePayload = "f8ff".repeat(320);
const silenceAudioPayload = Buffer.from(hexSilencePayload, "hex"); // 640-byte payload for silence - 16 bits - 16 kHz - PCM

//--- Backtrack audio payload handling for WebSocket to Deepgram ---
const circularBuffer = require("circular-buffer");
// circular buffer size
const cbLength = Math.round(process.env.BACKTRACK_PAYLOAD_DURATION / 20);

//--- One of the parameters of a buffer instance for initial audio from PSTN 2 to be fowarded to WebSocket 1
const bufferedPacketsQty = Math.round(process.env.BUFFERED_PAYLOAD_DURATION / 20)

//--- Record all audio ? --
let recordAllAudio = false;
if (process.env.RECORD_ALL_AUDIO == "true") { recordAllAudio = true };

//-------------------------

// ONLY if needed - For self-signed certificate in chain - In test environment
// Must leave next line as a comment in production environment
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

//---- DeepGram ASR engine ----

const dgApiKey = process.env.DEEPGRAM_API_KEY;
const dgWsListenEndpoint = process.env.DEEPGRAM_WS_LISTEN_ENDPOINT_URL;
let dgSttDiarize = process.env.DEEPGRAM_STT_DIARIZE == "true" ? true : false;
let dgSttLanguageCode = process.env.DEEPGRAM_STT_LANGUAGE;
const dgSttModel = process.env.DEEPGRAM_STT_MODEL;
const dgSttSmartFormat = process.env.DEEPGRAM_STT_SMART_FORMAT;

//---- Track instances and readiness of WebSockets 1 and 2 ----

let wsTracking = {};

function createWsTracking(id) {
  wsTracking[id] = {};
  wsTracking[id]["ws1Instance"] = null;
  wsTracking[id]["ws2Instance"] = null;
  wsTracking[id]["sendAudioToWs1"] = false; // WebSocket 1 is ready to receive audio
  wsTracking[id]["sendAudioToWs2"] = false; // WebSocket 2 is ready to receive audio
  wsTracking[id]["sendAudioToDg"] = false; // if true, stop sendind keep alive to DG and send actual audio to DG
  wsTracking[id]["bufferToWs1Sent"] = false; // content of buffer to WebSocket 1 has been sent?
}

function deleteFromWsTracking(uuid) {
  delete wsTracking[uuid];
}


//--- Websocket server (for WebSocket 1 leg from Vonage Voice API platform) - No STT - No connection to any AI engine ---
//--- Just for receiving/sending audio from/to PSTN 2 leg --

app.ws('/socket1', async (ws, req) => {

  console.log('\new>>> WebSocket 1 established');

  const callee = req.query.callee;
  const originalUuid = req.query.original_uuid;

  console.log('>>> Original uuid:', originalUuid);

  createWsTracking(originalUuid);
  wsTracking[originalUuid]["ws1Instance"] = ws;
  wsTracking[originalUuid]["sendAudioToWs1"] = true;

  //-- audio recording file -- 
  //-- here, you may create your own WebSocket audio recording file name template after './recordings/'
  const audioFromPstn1ToPstn2FileName = './recordings/' + moment(Date.now()).format('YYYY-MM-DD_HH-mm-ss-SSS') + '_original-uuid_' + originalUuid + '_from-pstn1-to-pstn2.raw'; // using server local time
  // const audioFromPstn1ToPstn2FileName = './recordings/' + moment.utc(Date.now()).format('YYYY-MM-DD_HH-mm-ss-SSS') + '_original-uuid_' + originalUuid  + '_from-pstn1-to-pstn2.raw'; // using UTC
  
  if (recordAllAudio) { 

    try {
      await fsp.writeFile(audioFromPstn1ToPstn2FileName, '');
    } catch(e) {
      console.log('>>> Error creating file', audioFromPstn1ToPstn2FileName, e);
    }

  }

  //---------------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log("\n>>> Websocket text message:", msg);    
    
    } else {

      if (wsTracking[originalUuid]["sendAudioToWs2"]) { // is WebSocket 2 leg ready to receive messages?

        // forward current payload
        wsTracking[originalUuid]["ws2Instance"].send(msg);
        // process.stdout.write(".");

        if (recordAllAudio) {
          try {
            fsp.appendFile(audioFromPstn1ToPstn2FileName, msg, 'binary');
          } catch(error) {
            console.log(">>> Error writing to file", audioFromPstn1ToPstn2FileName, error);
          }
        } 

      } else {  // while WebSocket 2 is not yet up, send silence audio payload back to VG on this WebSocket 1 leg

        ws.send(silenceAudioPayload);
        process.stdout.write(".");

      }

    }

  });

  //--

  ws.on('close', async () => {

    wsTracking[originalUuid]["sendAudioToWs1"] = false;

    console.log(">>>\nWebSocket 1 closed - Original uuid", originalUuid);

    setTimeout( () => {
      deleteFromWsTracking(originalUuid);
    }, 10000);
  
  });

});

//--- Websocket server (for WebSocket 2 leg from Vonage Voice API platform) - Deepgram transcribe live streaming audio ---

app.ws('/socket2', async (ws, req) => {

  console.log('\n>>> WebSocket 2 established');

  const callee = req.query.callee;
  const webhookUrl = req.query.webhook_url;
  const originalUuid = req.query.original_uuid;
  console.log('>>> Original uuid:', originalUuid);

  //--

  let keepAliveTimer;
  let p2ToW1BufferIndex = 0;
  let initialAudioChunks = [];

  //--

  wsTracking[originalUuid]["ws2Instance"] = ws;
  wsTracking[originalUuid]["sendAudioToWs2"] = true;

  const outboundPstn = req.query.outbound_pstn == "true" ? true : false; 

  let backTrackBuffer = new circularBuffer(cbLength);
  let backtrackPayloadSent = false;

  wsTracking[originalUuid]["sendAudioToDg"] = true;

  if (outboundPstn) {
    wsTracking[originalUuid]["sendAudioToDg"] = false;
  }

  console.log('>>> send audio to Deegram:', wsTracking[originalUuid]["sendAudioToDg"]);

  //-- audio recording file -- 
  //-- here, you may create your own PSTN audio recording file name template after './recordings/'
  const audioFromVgFileName = './recordings/' + moment(Date.now()).format('YYYY-MM-DD_HH-mm-ss-SSS') + '_original-uuid_' + originalUuid  + '_from-vg.raw'; // using server local time
  // const audioFromVgFileName = './recordings/' + moment.utc(Date.now()).format('YYYY-MM-DD_HH-mm-ss-SSS') + '_original-uuid_' + originalUuid  + '_from-vg.raw'; // using UTC
  
  if (recordAllAudio) { 

    try {
      await fsp.writeFile(audioFromVgFileName, '');
    } catch(e) {
      console.log('>>> Error creating file', audioFromVgFileName, e);
    }

  }

  //-- for tests only --
  let previousTime = Date.now();
  let now = previousTime;

  //--

  let dgJwt = null;

  try { 
    
    const response = await axios.post('https://api.deepgram.com/v1/auth/grant',
      {
      },
      {
        headers: {
          "Authorization": 'Token ' + dgApiKey,
        }
      }
    );

    // console.log('reponse:', response)
    
    dgJwt = response.data.access_token;
    // console.log('dgJwt:', dgJwt);
  
  } catch (error) {
    
    console.log('\n>>> Failed to get a Deepgram JWT:', error);
  
  }

  //--

  if (req.query.diarize) {
    dgSttDiarize = req.query.diarize;   // ability to override on a per session basis (per incoming WebSocket)
  }

  //--

  if (req.query.language_code) {
    dgSttLanguageCode = req.query.language_code; // ability to override on a per session basis (per incoming WebSocket)
  }

  //--

  let dgWsOpen = false;

  //--

  console.log('Creating WebSocket connection to DeepGram');

  const wsDGUri = dgWsListenEndpoint + '?callback=' + webhookUrl + 
  '&diarize=' + dgSttDiarize + '&encoding=linear16&sample_rate=16000' + 
  '&language=' + dgSttLanguageCode + '&model=' + dgSttModel + '&punctuate=true' + '&endpointing=10' + 
  '&extra=original_uuid:' + originalUuid + '&extra=callee_number:' + callee +'&extra=language_code:' + dgSttLanguageCode;
 
  console.log('Deepgram WebSocket URI:', wsDGUri);

  const wsDG = new webSocket("wss://" + wsDGUri, {
    // "headers": {"Authorization": "Token " + dgApiKey}
    "headers": {"Authorization": "Bearer " + dgJwt}
  });

  //--

  wsDG.on('error', async (event) => {

    console.log('WebSocket to Deepgram error:', event);

  });  

  //-- 

  wsDG.on('open', () => {
      console.log('WebSocket to Deepgram opened');
      dgWsOpen = true;
  });

  //--

  wsDG.on('message', async(msg, isBinary) =>  {

    // const response = JSON.parse(msg);
    // console.log("\n", response);

    console.log("\nReceived Deegpram data:", msg);
    console.log("\nReceived Deegpram data is binary:", isBinary);

  });

  //--

  wsDG.on('close', async () => {

    dgWsOpen = false; // stop sending audio payload to Deepgram platform
    
    console.log("Deepgram WebSocket closed");
  });

  //---------------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log("\n>>> Websocket text message:", msg);

      //-- this section is no longer applicable, instead out of band notification is used (see /pstn2answered route)
      // if (JSON.parse(msg).digit == '9') {     // received DTMF '9', outbound PSTN call has been answered
      //   sendAudioToDg = true;
      //   console.log('>>> sendAudioToDg:', sendAudioToDg);
      //   console.log('\n>>> Outbound PSTN call has been answered');
      // }    
    
    } else {

      // // see packet arrival timing - for debugging only
      // now = Date.now(); 
      // console.log('interval:', now - previousTime);
      // previousTime = now;

      //-- handling buffer for initial audio from PSTN 2 to WebSocket 1 
      if (!wsTracking[originalUuid]["bufferToWs1Sent"]) {

        // pstn2ToWs1Buffer.write(msg, p2ToW1BufferIndex * 640, "latin1");

        initialAudioChunks.push(msg);

        p2ToW1BufferIndex++;

        if (p2ToW1BufferIndex == bufferedPacketsQty) {

          wsTracking[originalUuid]["bufferToWs1Sent"] = true

          const pstn2ToWs1Buffer = Buffer.concat(initialAudioChunks);

          // send audio to ws 1
          if (wsTracking[originalUuid]["sendAudioToWs1"]) {
            wsTracking[originalUuid]["ws1Instance"].send(pstn2ToWs1Buffer);
          }  
        }

      }

      //-- sending audio to Deepgram STT/ASR
      if (dgWsOpen && wsTracking[originalUuid]["sendAudioToDg"]) {

        // send backtrack buffer content first
        if (!backtrackPayloadSent) {

          const qty = backTrackBuffer.size(); // number of elements in buffer

          for (let i = 0; i < qty; i++) {
            const bufferMessage = backTrackBuffer.deq();
            wsDG.send(bufferMessage);
            // process.stdout.write("+");
          }

          backtrackPayloadSent = true;
        }

        // forward current payload
        wsDG.send(msg);
        // process.stdout.write("-");

      } else {

        // insert payload to backtrack circular buffer
        backTrackBuffer.enq(msg);
        // process.stdout.write(">");

      }

      //-- forwarding audio to WebSocket 1 leg

      if (wsTracking[originalUuid]["sendAudioToWs1"] && wsTracking[originalUuid]["bufferToWs1Sent"]) { // is WebSocket 1 leg ready to receive messages and initial payload already sent?

        // forward current payload
        wsTracking[originalUuid]["ws1Instance"].send(msg);
        // process.stdout.write(">");
      } 

      //--

      if (recordAllAudio) {
        try {
          fsp.appendFile(audioFromVgFileName, msg, 'binary');
        } catch(error) {
          console.log(">>> Error writing to file", audioFromVgFileName, error);
        }
      } 

    }

  });

  //--

  ws.on('close', async () => {

    dgWsOpen = false;

    wsTracking[originalUuid]["sendAudioToWs2"] = false;
    
    backTrackBuffer = null;

    clearInterval(keepAliveTimer);

    wsDG.close();

    console.log(">>>\nWebSocket 2 closed - Original uuid", originalUuid);

    

    // setTimeout( () => {
    //   deleteFromWsTracking(originalUuid);
    // }, 10000);
  
  });

  //--

  if (!wsTracking[originalUuid]["sendAudioToDg"]) {

    keepAliveTimer = setInterval( () => {

      if (dgWsOpen) {
        const keepAliveMsg = JSON.stringify({ type: "KeepAlive" });
        wsDG.send(keepAliveMsg);
        // process.stdout.write(".");
      }  

      if(wsTracking[originalUuid]["sendAudioToDg"]) {
        clearInterval(keepAliveTimer);
        console.log('\n>>> Stop sending keep-alive silence packets to DG STT')
      }

    }, 5000) // every 5 sec (must be a few secs under 10 sec to avoid DG STT connection time out)

  }

});

//---- Notification that PSTN 2 call has been answered (out of bound notification for WebSocket 2) ---- 

app.post('/pstn2answered', async(req, res) => {

  res.status(200).send('Ok');

  wsTracking[req.body.original_uuid]["sendAudioToDg"] = true; // now send actual audio to DG

});

//--- If this application is hosted on VCR (Vonage Cloud Runtime) serverless infrastructure --------

app.get('/_/health', async(req, res) => {

  res.status(200).send('Ok');

});

//=========================================

const port = process.env.VCR_PORT || process.env.PORT || 6000;

app.listen(port, () => console.log(`Connector application listening on port ${port}!`));

//------------

