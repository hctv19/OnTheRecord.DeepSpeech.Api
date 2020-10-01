var app = require('express')();
var http = require('http').createServer(app);

const socketIO = require('socket.io');
const DeepSpeech = require('deepspeech');
const VAD = require('node-vad');

// Constants
const PORT = process.env.PORT || 8080;

// App
app.get('/', (req, res) => {
  res.send('Hello World');
});


let DEEPSPEECH_MODEL = __dirname + '/deepspeech-0.8.2-models'; // path to deepspeech english model directory
// let DEEPSPEECH_MODEL = '/ds-models/deepspeech-0.8.2-models'; // path to deepspeech english model directory

let SILENCE_THRESHOLD = 200; // how many milliseconds of inactivity before processing the audio

// const VAD_MODE = VAD.Mode.NORMAL;
// const VAD_MODE = VAD.Mode.LOW_BITRATE;
// const VAD_MODE = VAD.Mode.AGGRESSIVE;
const VAD_MODE = VAD.Mode.VERY_AGGRESSIVE;
const vad = new VAD(VAD_MODE);

function createModel(modelDir) {
let modelPath = modelDir + '.pbmm';
let scorerPath = modelDir + '.scorer';
let model = new DeepSpeech.Model(modelPath);
model.enableExternalScorer(scorerPath);
    return model;
}

let englishModel = createModel(DEEPSPEECH_MODEL);

let modelStream;
let recordedChunks = 0;
let silenceStart = null;
let recordedAudioLength = 0;
let endTimeout = null;
let silenceBuffers = [];

function processAudioStream(data, callback) {
    var buffer = Buffer.from(data);
    vad.processAudio(buffer, 16000).then((res) => {
        switch (res) {
            case VAD.Event.ERROR:
                console.log("VAD ERROR");
                break;
            case VAD.Event.NOISE:
                console.log("VAD NOISE");
                break;
            case VAD.Event.SILENCE:
                processSilence(buffer, callback);
                break;
            case VAD.Event.VOICE:
                processVoice(buffer);
                break;
            default:
                console.log('default', res);
                
        }
    });

    // timeout after 1s of inactivity
    clearTimeout(endTimeout);
        endTimeout = setTimeout(function() {
            console.log('timeout');
            resetAudioStream();
        }, 1000);
}

function endAudioStream(callback) {
    console.log('[end]');
    let results = intermediateDecode();
    if (results) {
        if (callback) {
            callback(results);
        }
    }
}

function resetAudioStream() {
    clearTimeout(endTimeout);
    console.log('[reset]');
    intermediateDecode(); // ignore results
    recordedChunks = 0;
    silenceStart = null;
}

function processSilence(data, callback) {
    if (recordedChunks > 0) { // recording is on
        process.stdout.write('-'); // silence detected while recording
        
        feedAudioContent(data);
        
        if (silenceStart === null) {
            silenceStart = new Date().getTime();
        }
        else {
            let now = new Date().getTime();
            if (now - silenceStart > SILENCE_THRESHOLD) {
                silenceStart = null;
                console.log('[end]');
                let results = intermediateDecode();
                if (results) {
                    if (callback) {
                        callback(results);
                    }
                }
            }
        }
    }
    else {
        process.stdout.write('.'); // silence detected while not recording
        bufferSilence(data);
    }
}

function bufferSilence(data) {
    // VAD has a tendency to cut the first bit of audio data from the start of a recording
    // so keep a buffer of that first bit of audio and in addBufferedSilence() reattach it to the beginning of the recording
    silenceBuffers.push(data);
    if (silenceBuffers.length >= 3) {
        silenceBuffers.shift();
    }
}

function addBufferedSilence(data) {
    let audioBuffer;
    if (silenceBuffers.length) {
        silenceBuffers.push(data);
        let length = 0;
        silenceBuffers.forEach(function (buf) {
            length += buf.length;
        });
        audioBuffer = Buffer.concat(silenceBuffers, length);
        silenceBuffers = [];
    }
    else audioBuffer = data;
    return audioBuffer;
}

function processVoice(data) {
    silenceStart = null;
    if (recordedChunks === 0) {
        console.log('');
        process.stdout.write('[start]'); // recording started
    }
    else {
        process.stdout.write('='); // still recording
    }
    recordedChunks++;

    data = addBufferedSilence(data);
    feedAudioContent(data);
}

function createStream() {
    modelStream = englishModel.createStream();
    recordedChunks = 0;
    recordedAudioLength = 0;
}

function finishStream() {
    if (modelStream) {
        let start = new Date();
        let text = modelStream.finishStream();
        if (text) {
            console.log('');
            console.log('Recognized Text:', text);
            let recogTime = new Date().getTime() - start.getTime();
            return {
                text,
                recogTime,
                audioLength: Math.round(recordedAudioLength)
            };
        }
    }
    silenceBuffers = [];
    modelStream = null;
}

function intermediateDecode() {
    let results = finishStream();
    createStream();
    return results;
}

function feedAudioContent(chunk) {
    console.log('feedAudioContent');
    recordedAudioLength += (chunk.length / 2) * (1 / 16000) * 1000;
    modelStream.feedAudioContent(chunk);
}

const io = socketIO(http, {});
io.set('origins', '*:*');

io.on('connection', function(socket) {
    console.log('client connected');

    socket.once('disconnect', () => {
        console.log('client disconnected');
    });

    createStream();

    socket.on('hi', function(data){
        console.log("hi received");
        socket.emit("hi");
    })

    socket.on('stream-data', function(data) {
        processAudioStream(data, (results) => {
            socket.emit('recognize', results);
        });
    });

    socket.on('stream-end', function() {
        endAudioStream((results) => {
            socket.emit('recognize', results);
        });
    });

    socket.on('stream-reset', function() {
        resetAudioStream();
    });
});
console.log("Starting app on PORT:", PORT);

http.listen(PORT, () => {
    console.log('listening on *:', PORT);
  });