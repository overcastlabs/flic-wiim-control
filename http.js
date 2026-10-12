// main.js
const flicapp = require("flicapp");
const http = require("http");

const addressMap = {
    // "Guest Speakers": "https://192.168.1.237",
    "Guest Speakers": "http://192.168.1.9:8888/wiim-guestroom",
    "Downstairs Speakers": "http://192.168.1.9:8888/wiim-downstairs",
}

const baseCommand = "/httpapi.asp?command="

const volumeCommand = "setPlayerCmd:vol"
const muteCommand = "setPlayerCmd:mute"
const presetCommand = "setPlayerCmd:MCUKeyShortClick"

const debugOutput = true;

function debugLog(...message) {
    if (debugOutput) {
        console.log(...message);
    }
}

function throttle(mainFunction, delay = 100) {
    let timerFlag = null;
    return (...args) => {
        if (timerFlag === null) {
            mainFunction(...args);
            timerFlag = setTimeout(() => {
                timerFlag = null;
            }, delay);
        }
    };
};

function sendCommand(virtualDeviceId, command, value) {
    let url = addressMap[virtualDeviceId] + baseCommand + command;
    if (value) {
        url += ":" + value;
    }
    debugLog(url);
    http.makeRequest({
		url,
		method: "GET",
	}, function(err, res) {
        if (err) {
            console.log("API Error: " + err)
        } else if (res) {
            debugLog("Request response: " + res.content);
        }
	});
};

function normalizeVolume(volume) {
    return Math.round(volume * 100);
}

function handleActionMessage(message) {
    switch (message) {
        case "mute":
            sendCommand("Guest Speakers", muteCommand, "1");
            break;
        case "kexp":
            sendCommand("Guest Speakers", presetCommand, "1");
            break;
        case "kuow":
            sendCommand("Guest Speakers", presetCommand, "2");
            break;
        default:
            break;
    }
}
flicapp.on("actionMessage", handleActionMessage);

function handleVirtualDeviceUpdate(metaData, values) {
    if(values.volume && values.volume != "") {
        sendCommand(metaData.virtualDeviceId, volumeCommand, normalizeVolume(values.volume));
    }
    debugLog("device ID: " + metaData.virtualDeviceId);
    debugLog("volume: " + values.volume);
}
flicapp.on("virtualDeviceUpdate", throttle(handleVirtualDeviceUpdate));

// On Wiim state change, call
// flicapp.VirtualDeviceUpdateState(type, id, values)
// flicapp.VirtualDeviceUpdateState("Speaker", id, values)

sendCommand("Guest Speakers", "getPlayerStatus")
// client.on("data", function(data) {
// 	debugLog("Received: " + data);
// 	// flicapp.VirtualDeviceUpdateState("Speaker", "Guest Speakers", values)
// });