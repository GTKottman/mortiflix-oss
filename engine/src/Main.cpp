// mortiflix-engine (doc 16): the mini DAW's sound engine. JUCE + Tracktion Engine. The studio starts it and talks to it
// over stdin/stdout (JSON lines, step E2); for now it answers --version and --selftest.
//   --version    one JSON line: this engine's version and the pinned Tracktion Engine and JUCE commits
//   --selftest   renders 1 s of a 1 kHz test tone through a Tracktion Edit into memory (no sound device) and checks it
//   --serve      the studio protocol on stdin / stdout (doc 16 §4)
//   --ramp-test <dir>  writes ramped.wav and unramped.wav: a 100 Hz sine through the fader jumping -20 → 0 dB, with and
//                without our 20 ms ramp (doc 15 Q9; the test filters and measures them)
//   --render <song.json> --settings <render.json> --out <dir>
//                a one-shot offline render (doc 24 §1): 48 kHz 32-bit float, master plugins on, our settings always,
//                faster than real time; writes mix-f32.wav and render-report.json
// Whatever JUCE, Tracktion or a plugin prints goes to stderr: stdout carries only our JSON.
#include <JuceHeader.h>
#include <iostream>
#include "Protocol.h"
#include "SongBuilder.h"

namespace te = tracktion;

namespace
{
    // No sound device for the self-test: the engine must work with nothing plugged in.
    struct NoDeviceBehaviour : te::EngineBehaviour
    {
        bool autoInitialiseDeviceManager() override { return false; }
    };

    // A render's thread count (doc 24 §1: the same file at 1 or 8 threads).
    struct RenderBehaviour : NoDeviceBehaviour
    {
        explicit RenderBehaviour (int t) : threads (juce::jmax (1, t)) {}
        int getNumberOfCPUsToUseForAudio() override { return threads; }
        int threads;
    };

    // Jobs that show a progress bar in a GUI (renders) run here on their own thread while the message loop turns.
    struct HeadlessUI : te::UIBehaviour
    {
        void runTaskWithProgressBar (te::ThreadPoolJobWithProgress& job) override
        {
            struct Runner : juce::Thread
            {
                explicit Runner (te::ThreadPoolJobWithProgress& j) : juce::Thread (j.getJobName()), job (j) { startThread(); }
                ~Runner() override { job.signalJobShouldExit(); waitForThreadToExit (10000); }
                void run() override { while (! threadShouldExit()) if (job.runJob() == juce::ThreadPoolJob::jobHasFinished) break; }
                te::ThreadPoolJobWithProgress& job;
            } runner (job);
            while (runner.isThreadRunning())
                if (! juce::MessageManager::getInstance()->runDispatchLoopUntil (10))
                    break;
        }
    };

    int protoFd = 1;
    juce::String json (const juce::var& v) { return juce::JSON::toString (v, true); }
    void emit (const juce::var& v) { auto line = json (v) + "\n"; auto s = line.toRawUTF8(); [[maybe_unused]] auto n = ::write (protoFd, s, std::strlen (s)); }

    // Our defaults, not Tracktion's (doc 15 A5): the -3 dB constant-power pan law. Tracktion's default is linear (+6 dB
    // at hard pan), and each track's VolumeAndPanPlugin stores its own law, reading as linear when unset (its
    // CachedValue<int> defaults to 0 = PanLawLinear), so every track's volume plugin is set explicitly (trackPanLaw).
    // Denormals: Tracktion's device callback and graph workers already flush them (checked in its source:
    // DeviceManager::audioDeviceIOCallbackWithContext, NodePlayerThreadPools::runThread).
    void applyDefaults() { te::setDefaultPanLaw (te::PanLaw3dBCenter); }
    void ourPlugins (te::Engine& engine) { mfx::registerOurPlugins (engine); }
    // (Song tracks use our mfx-strip for fader and pan instead, with Tracktion's volume plugin at unity: SongBuilder.h.)
    void trackPanLaw (te::AudioTrack& t) { t.getVolumePlugin()->setPanLaw (te::PanLaw3dBCenter); }

    juce::DynamicObject::Ptr versions()
    {
        juce::DynamicObject::Ptr o = new juce::DynamicObject();
        o->setProperty ("name", "mortiflix-engine");
        o->setProperty ("version", MFX_ENGINE_VERSION);
        o->setProperty ("tracktion_engine", MFX_TE_COMMIT);
        o->setProperty ("juce", MFX_JUCE_COMMIT);
        o->setProperty ("juce_version", juce::SystemStats::getJUCEVersion());
        return o;
    }

    int version() { emit (juce::var (versions().get())); return 0; }

    // One track with Tracktion's tone generator at 1 kHz, level 0.5 (−6.02 dBFS), rendered offline at 48 kHz into
    // memory: centred it must come out at −3 dB per channel (the pan law), panned hard left at full level.
    te::Renderer::Statistics renderTone (te::Engine& engine, float pan)
    {
        auto edit = te::Edit::createSingleTrackEdit (engine, te::Edit::EditRole::forRendering);
        edit->ensureNumberOfAudioTracks (1);
        edit->getMasterVolumePlugin()->setVolumeDb (0.0f);
        auto track = te::getAudioTracks (*edit)[0];
        track->getVolumePlugin()->setVolumeDb (0.0f);
        trackPanLaw (*track);
        track->getVolumePlugin()->setPan (pan);
        auto plugin = edit->getPluginCache().createNewPlugin (te::ToneGeneratorPlugin::xmlTypeName, {});
        track->pluginList.insertPlugin (plugin, 0, nullptr);
        auto tone = dynamic_cast<te::ToneGeneratorPlugin*> (plugin.get());
        tone->frequencyParam->setParameter (1000.0f, juce::dontSendNotification);
        tone->levelParam->setParameter (0.5f, juce::dontSendNotification);
        juce::BigInteger tracks;
        tracks.setBit (te::getAllTracks (*edit).indexOf (track));
        return te::Renderer::measureStatistics ("selftest", *edit, te::TimeRange (te::TimePosition(), te::TimePosition::fromSeconds (1.0)), tracks, 512, 48000.0);
    }

    int selftest()
    {
        te::Engine engine { "mortiflix-engine", std::make_unique<HeadlessUI>(), std::make_unique<NoDeviceBehaviour>() };
        ourPlugins (engine);
        applyDefaults();
        engine.getPluginManager().createBuiltInType<te::ToneGeneratorPlugin>();
        auto centre = renderTone (engine, 0.0f);
        auto left = renderTone (engine, -1.0f);
        const float c = 0.5f * std::sqrt (0.5f);   // −3.01 dB of 0.5
        const bool rendered = std::abs (centre.audioDuration - 1.0f) < 0.001f;
        const bool panLaw = std::abs (centre.peak - c) < 0.002f && std::abs (left.peak - 0.5f) < 0.002f;
        auto o = new juce::DynamicObject();
        o->setProperty ("ok", rendered && panLaw);
        o->setProperty ("peak", centre.peak);
        o->setProperty ("peak_db", juce::Decibels::gainToDecibels (centre.peak, -150.0f));
        o->setProperty ("average", centre.average);
        o->setProperty ("seconds", centre.audioDuration);
        o->setProperty ("sample_rate", 48000.0);
        o->setProperty ("pan_law", "-3 dB centre");
        o->setProperty ("hard_left_peak", left.peak);
        emit (juce::var (o));
        return rendered && panLaw ? 0 : 1;
    }

    // ---- the offline render (doc 24 §1, doc 16 E5) ----
    juce::String sha256Of (const juce::File& f)
    {
        juce::FileInputStream in (f);
        return in.openedOk() ? juce::SHA256 (in).toHexString() : juce::String();
    }

    bool stripMetadata (const juce::File& f, double rate)
    {
        juce::AudioFormatManager fm;
        fm.registerBasicFormats();
        auto reader = std::unique_ptr<juce::AudioFormatReader> (fm.createReaderFor (f));
        if (reader == nullptr) return false;
        juce::AudioBuffer<float> buf ((int) reader->numChannels, (int) reader->lengthInSamples);
        reader->read (&buf, 0, buf.getNumSamples(), 0, true, true);
        reader.reset();
        auto tmp = f.getSiblingFile (f.getFileName() + ".tmp");
        {
            auto out = std::unique_ptr<juce::OutputStream> (tmp.createOutputStream().release());
            juce::WavAudioFormat wav;
            auto opts = juce::AudioFormatWriterOptions{}.withSampleRate (rate).withNumChannels (buf.getNumChannels())
                                                         .withBitsPerSample (32).withSampleFormat (juce::AudioFormatWriterOptions::SampleFormat::floatingPoint);
            auto writer = wav.createWriterFor (out, opts);
            if (writer == nullptr) return false;
            writer->writeFromAudioSampleBuffer (buf, 0, buf.getNumSamples());
        }
        return tmp.moveFileTo (f);
    }

    int renderSong (const juce::String& songPath, const juce::String& settingsPath, const juce::String& outPath)
    {
        juce::File songFile (songPath), outDir (outPath);
        auto song = juce::JSON::parse (songFile);
        auto settings = settingsPath.isNotEmpty() ? juce::JSON::parse (juce::File (settingsPath)) : juce::var (new juce::DynamicObject());
        if (! song.isObject()) { std::cerr << "the song file isn't JSON: " << songPath << std::endl; return 2; }
        const int threads = (int) settings.getProperty ("threads", 8);
        const int block = (int) settings.getProperty ("blockSize", 512);
        const double rate = (double) settings.getProperty ("rate", 48000);
        outDir.createDirectory();

        te::Engine engine { "mortiflix-engine", std::make_unique<HeadlessUI>(), std::make_unique<RenderBehaviour> (threads) };
        ourPlugins (engine);
        applyDefaults();
        auto built = mfx::buildSong (engine, song);
        auto& edit = *built.edit;

        // our settings, never Tracktion's defaults (16-bit, 44.1 kHz, no master plugins)
        te::Renderer::Parameters p (edit);
        p.destFile = outDir.getChildFile ("mix-f32.wav");
        p.audioFormat = engine.getAudioFileFormatManager().getWavFormat();
        p.bitDepth = 32;
        p.sampleRateForAudio = rate;
        p.blockSizeForAudio = block;
        // the whole song, or a window of it in samples (doc 15 Q2: one bar of a 2-hour song), "toSample" exclusive
        const juce::int64 from = (juce::int64) settings.getProperty ("fromSample", 0);
        const juce::int64 to = settings.hasProperty ("toSample") ? (juce::int64) settings["toSample"] : (juce::int64) std::llround (edit.getLength().inSeconds() * rate);
        p.time = te::TimeRange (te::TimePosition::fromSamples (from, rate), te::TimePosition::fromSamples (to, rate));
        // every track (Tracktion's renderToFile renders nothing when this is empty, whatever its comment says)
        auto all = te::getAllTracks (edit);
        for (int i = 0; i < all.size(); ++i) p.tracksToDo.setBit (i);
        p.usePlugins = true;
        p.useMasterPlugins = true;
        p.realTimeRender = false;
        p.ditheringEnabled = false;
        p.canRenderInMono = false;
        p.checkNodesForAudio = false;   // a silent song still renders (to silence)
        p.destFile.deleteFile();
        const auto t0 = juce::Time::getMillisecondCounterHiRes();
        auto written = te::Renderer::renderToFile ("render", p);
        // Tracktion writes a Broadcast WAV chunk with the render's date and time: the same song and settings must give
        // the same file, so it is written again, plain (no metadata), samples untouched
        if (written.existsAsFile()) stripMetadata (written, rate);
        const double ms = juce::Time::getMillisecondCounterHiRes() - t0;

        // what was really written
        juce::int64 frames = 0; int channels = 0; int bits = 0; bool isFloat = false; double fileRate = 0;
        {
            juce::AudioFormatManager fm;
            fm.registerBasicFormats();
            if (auto r = std::unique_ptr<juce::AudioFormatReader> (fm.createReaderFor (p.destFile)))
            { frames = r->lengthInSamples; channels = (int) r->numChannels; bits = (int) r->bitsPerSample; isFloat = r->usesFloatingPointData; fileRate = r->sampleRate; }
        }
        auto report = new juce::DynamicObject();
        auto ver = versions();
        report->setProperty ("engine", juce::var (ver.get()));
        auto used = new juce::DynamicObject();
        used->setProperty ("rate", rate);
        used->setProperty ("bits", 32);
        used->setProperty ("float", true);
        used->setProperty ("blockSize", block);
        used->setProperty ("threads", threads);
        used->setProperty ("masterPlugins", true);
        used->setProperty ("realTime", false);
        used->setProperty ("tracktionDither", false);
        used->setProperty ("panLaw", "-3 dB centre");
        used->setProperty ("fromSample", from);
        used->setProperty ("toSample", to);
        report->setProperty ("settings", juce::var (used));
        juce::Array<juce::var> plugins;
        for (auto* pl : te::getAllPlugins (edit, false))
        {
            auto o = new juce::DynamicObject();
            o->setProperty ("name", pl->getName());
            o->setProperty ("type", pl->getPluginType());
            plugins.add (juce::var (o));
        }
        report->setProperty ("plugins", plugins);
        report->setProperty ("tracks", built.tracks);
        report->setProperty ("notes", built.notes);
        report->setProperty ("seconds", edit.getLength().inSeconds());
        report->setProperty ("frames", frames);
        auto file = new juce::DynamicObject();
        file->setProperty ("name", p.destFile.getFileName());
        file->setProperty ("rate", fileRate);
        file->setProperty ("channels", channels);
        file->setProperty ("bits", bits);
        file->setProperty ("float", isFloat);
        file->setProperty ("sha256", sha256Of (p.destFile));
        juce::Array<juce::var> files;
        files.add (juce::var (file));
        report->setProperty ("files", files);
        report->setProperty ("ms", ms);
        const bool ok = written.existsAsFile() && frames > 0 && isFloat && (int) fileRate == (int) rate;
        report->setProperty ("ok", ok);
        const juce::var reportVar (report);   // one owner: a second var (report) would hold a freed object
        outDir.getChildFile ("render-report.json").replaceWithText (json (reportVar));
        emit (reportVar);
        return ok ? 0 : 1;
    }

    // ---- sound out (doc 16 E3) ----
    juce::var deviceList (te::Engine& engine)
    {
        auto& adm = engine.getDeviceManager().deviceManager;
        juce::Array<juce::var> out;
        for (auto* type : adm.getAvailableDeviceTypes())
        {
            type->scanForDevices();
            auto o = new juce::DynamicObject();
            o->setProperty ("backend", type->getTypeName());
            juce::Array<juce::var> names;
            for (auto& n : type->getDeviceNames (false)) names.add (n);
            o->setProperty ("devices", names);
            out.add (juce::var (o));
        }
        return out;
    }

    juce::var deviceState (te::Engine& engine)
    {
        auto& adm = engine.getDeviceManager().deviceManager;
        auto* dev = adm.getCurrentAudioDevice();
        auto o = new juce::DynamicObject();
        o->setProperty ("state", dev != nullptr && dev->isOpen() ? "open" : "closed");
        if (dev != nullptr)
        {
            o->setProperty ("backend", adm.getCurrentAudioDeviceType());
            o->setProperty ("name", dev->getName());
            o->setProperty ("rate", dev->getCurrentSampleRate());
            o->setProperty ("block", dev->getCurrentBufferSizeSamples());
            o->setProperty ("outLatency", dev->getOutputLatencyInSamples());
            o->setProperty ("xruns", dev->getXRunCount());
        }
        return juce::var (o);
    }

    juce::var deviceSet (te::Engine& engine, const juce::var& args)
    {
        auto& dm = engine.getDeviceManager();
        auto& adm = dm.deviceManager;
        const auto backend = args.getProperty ("backend", "JACK").toString();
        if (adm.getCurrentAudioDevice() == nullptr) dm.initialise (0, 2);
        // Tracktion rescans MIDI devices every 4 s by default; a change (even the system's "Midi Through" port appearing)
        // reallocates playback and stops the transport mid-song. MIDI hardware is scanned on purpose when it's wanted.
        dm.setMidiDeviceScanIntervalSeconds (0);
        adm.setCurrentAudioDeviceType (backend, true);
        if (adm.getCurrentAudioDeviceType() != backend) throw std::runtime_error (("no " + backend + " backend here").toStdString());
        auto setup = adm.getAudioDeviceSetup();
        // the named output, or the system's default one (never whatever an earlier run left in Tracktion's settings)
        if (args.hasProperty ("name") && args["name"].toString().isNotEmpty()) setup.outputDeviceName = args["name"].toString();
        else if (auto* type = adm.getCurrentDeviceTypeObject())
        {
            type->scanForDevices();
            const auto names = type->getDeviceNames (false);
            const int def = type->getDefaultDeviceIndex (false);
            if (def >= 0 && def < names.size()) setup.outputDeviceName = names[def];
        }
        setup.sampleRate = (double) args.getProperty ("rate", 48000);
        setup.bufferSize = (int) args.getProperty ("block", 1024);
        setup.useDefaultInputChannels = false;
        setup.inputChannels.clear();
        setup.useDefaultOutputChannels = false;
        setup.outputChannels.clear();
        setup.outputChannels.setRange (0, 2, true);
        auto err = adm.setAudioDeviceSetup (setup, true);
        if (err.isNotEmpty()) throw std::runtime_error (err.toStdString());
        dm.rescanWaveDeviceList();
        return deviceState (engine);
    }

    // The studio protocol: commands on the message thread, until engine.quit or the studio closes stdin.
    struct Server : juce::Timer
    {
        te::Engine engine { "mortiflix-engine", std::make_unique<HeadlessUI>(), std::make_unique<NoDeviceBehaviour>() };
        std::unique_ptr<mfx::Protocol> proto;
        std::unique_ptr<te::Edit> toneEdit;
        std::unique_ptr<te::Edit> songEdit;
        juce::String songPath;
        int lastXruns = 0;

        // the clock (doc 16 §5): 30 a second while playing, 2 when stopped
        struct Clock : juce::Timer
        {
            Server& s;
            explicit Clock (Server& o) : s (o) {}
            void timerCallback() override { s.tick(); }
        } clock { *this };
        bool wasPlaying = false;

        Server()
        {
            applyDefaults();
            ourPlugins (engine);
            engine.getPluginManager().createBuiltInType<te::ToneGeneratorPlugin>();
            proto = std::make_unique<mfx::Protocol> (protoFd, [this] (const juce::String& cmd, const juce::var& args) { return handle (cmd, args); });
            proto->onEnd = [] { juce::MessageManager::getInstance()->stopDispatchLoop(); };
        }

        juce::var handle (const juce::String& cmd, const juce::var& args)
        {
            if (cmd == "engine.hello")
            {
                auto o = versions();
                o->setProperty ("rate", 48000);
                o->setProperty ("pan_law", "-3 dB centre");
                o->setProperty ("device", engine.getDeviceManager().deviceManager.getCurrentAudioDevice() ? deviceState (engine) : juce::var());
                return juce::var (o.get());
            }
            if (cmd == "engine.quit") { juce::MessageManager::callAsync ([] { juce::MessageManager::getInstance()->stopDispatchLoop(); }); return juce::var (new juce::DynamicObject()); }
            if (cmd == "device.list") return deviceList (engine);
            if (cmd == "device.set")
            {
                auto st = deviceSet (engine, args);
                lastXruns = (int) st["xruns"];
                startTimer (500);
                proto->event ("device", st.getDynamicObject());
                return st;
            }
            if (cmd == "engine.tone") return tone (args);
            if (cmd == "mixer.set") return mixerSet (args);
            if (cmd == "song.load") return songLoad (args, false);
            if (cmd == "song.patch") return songLoad (args, true);
            if (cmd == "transport.play" || cmd == "transport.stop" || cmd == "transport.seek") return transport (cmd, args);
            if (cmd == "clock.subscribe") { clock.startTimerHz (2); return juce::var (new juce::DynamicObject()); }
            throw std::runtime_error (("unknown command " + cmd).toStdString());
        }

        // A test tone through the real path: an Edit with Tracktion's tone generator, played by its transport on the
        // open device. Answers at once; a "tone" event says when it ended and how many xruns happened meanwhile.
        juce::var tone (const juce::var& args)
        {
            if (engine.getDeviceManager().deviceManager.getCurrentAudioDevice() == nullptr) throw std::runtime_error ("no sound device open: device.set first");
            const float hz = (float) (double) args.getProperty ("hz", 1000.0);
            const float db = (float) (double) args.getProperty ("db", -20.0);
            const int ms = (int) args.getProperty ("ms", 1000);
            toneEdit = te::Edit::createSingleTrackEdit (engine, te::Edit::EditRole::forEditing);
            toneEdit->ensureNumberOfAudioTracks (1);
            toneEdit->getMasterVolumePlugin()->setVolumeDb (0.0f);
            auto track = te::getAudioTracks (*toneEdit)[0];
            track->getVolumePlugin()->setVolumeDb (0.0f);
            trackPanLaw (*track);
            track->getVolumePlugin()->setPan (0.0f);
            auto plugin = toneEdit->getPluginCache().createNewPlugin (te::ToneGeneratorPlugin::xmlTypeName, {});
            track->pluginList.insertPlugin (plugin, 0, nullptr);
            auto t = dynamic_cast<te::ToneGeneratorPlugin*> (plugin.get());
            t->frequencyParam->setParameter (hz, juce::dontSendNotification);
            // the pan law takes 3 dB at centre: the generator is set 3 dB higher so each channel is at the asked level
            t->levelParam->setParameter (juce::jlimit (0.00001f, 1.0f, juce::Decibels::decibelsToGain (db + 3.0103f)), juce::dontSendNotification);
            auto& tc = toneEdit->getTransport();
            tc.ensureContextAllocated();
            const int before = engine.getDeviceManager().deviceManager.getCurrentAudioDevice()->getXRunCount();
            tc.play (false);
            juce::Timer::callAfterDelay (ms, [this, before]
            {
                if (toneEdit == nullptr) return;
                toneEdit->getTransport().stop (false, false);
                juce::DynamicObject::Ptr o = new juce::DynamicObject();
                o->setProperty ("state", "done");
                auto* dev = engine.getDeviceManager().deviceManager.getCurrentAudioDevice();
                o->setProperty ("xruns", dev ? dev->getXRunCount() - before : -1);
                proto->event ("tone", o);
            });
            auto o = new juce::DynamicObject();
            o->setProperty ("playing", true);
            return juce::var (o);
        }

        // The song file → an Edit on the open device. song.patch rebuilds it from the file again (the studio wrote the
        // change there first), keeping where it was and whether it was playing.
        juce::var songLoad (const juce::var& args, bool keepPlace)
        {
            const auto path = args.getProperty ("path", songPath).toString();
            juce::File f (path);
            if (! f.existsAsFile()) throw std::runtime_error (("no song file at " + path).toStdString());
            auto song = juce::JSON::parse (f);
            if (! song.isObject()) throw std::runtime_error ("the song file isn't JSON");
            double at = (double) args.getProperty ("atSeconds", 0.0);
            bool play = false;
            if (keepPlace && songEdit != nullptr) { at = songEdit->getTransport().getPosition().inSeconds(); play = songEdit->getTransport().isPlaying(); }
            const auto t0 = juce::Time::getMillisecondCounterHiRes();
            if (songEdit != nullptr) songEdit->getTransport().stop (false, true);
            songEdit.reset();
            auto built = mfx::buildSong (engine, song);
            songEdit = std::move (built.edit);
            songPath = path;
            auto& tc = songEdit->getTransport();
            if (engine.getDeviceManager().deviceManager.getCurrentAudioDevice() != nullptr) tc.ensureContextAllocated();
            tc.setPosition (te::TimePosition::fromSeconds (at));
            if (play) tc.play (false);
            clock.startTimerHz (play ? 30 : 2);
            auto o = new juce::DynamicObject();
            o->setProperty ("tracks", built.tracks);
            o->setProperty ("clips", built.clips);
            o->setProperty ("notes", built.notes);
            o->setProperty ("seconds", built.seconds);
            o->setProperty ("ms", juce::Time::getMillisecondCounterHiRes() - t0);
            return juce::var (o);
        }

        // A live fader or pan move (doc 22 §7 mixer.set): { channel | insert, field: volDb | pan, value }, ramped over 20 ms
        // by the strip. The song file isn't changed here (the studio saves it and sends song.patch).
        juce::var mixerSet (const juce::var& args)
        {
            if (songEdit == nullptr) throw std::runtime_error ("no song loaded");
            const auto field = args["field"].toString();
            if (field != "volDb" && field != "pan") throw std::runtime_error (("mixer.set can't set " + field + " yet").toStdString());
            const auto channel = args["channel"].toString(), insert = args["insert"].toString();
            for (auto* t : te::getAudioTracks (*songEdit))
                for (auto* pl : t->pluginList)
                    if (auto* strip = dynamic_cast<mfx::StripPlugin*> (pl))
                        if ((channel.isNotEmpty() && strip->channelId == channel) || (insert.isNotEmpty() && strip->insertId == insert))
                        {
                            const double v = (double) args["value"];
                            if (field == "volDb") strip->state.volDb = juce::jlimit (mfx::floorDb, 12.0, v);
                            else strip->state.pan = juce::jlimit (-1.0, 1.0, v);
                            auto o = new juce::DynamicObject();
                            o->setProperty ("channel", strip->channelId);
                            o->setProperty ("field", field);
                            o->setProperty ("value", field == "volDb" ? strip->state.volDb.load() : strip->state.pan.load());
                            return juce::var (o);
                        }
            throw std::runtime_error (("no channel " + channel + insert).toStdString());
        }

        juce::var transport (const juce::String& cmd, const juce::var& args)
        {
            if (songEdit == nullptr) throw std::runtime_error ("no song loaded");
            if (engine.getDeviceManager().deviceManager.getCurrentAudioDevice() == nullptr) throw std::runtime_error ("no sound device open: device.set first");
            auto& tc = songEdit->getTransport();
            tc.ensureContextAllocated();
            if (args.hasProperty ("seconds")) tc.setPosition (te::TimePosition::fromSeconds ((double) args["seconds"]));
            if (cmd == "transport.play") { tc.play (false); clock.startTimerHz (30); }
            if (cmd == "transport.stop") { tc.stop (false, false); clock.startTimerHz (2); }
            tick();
            return clockState();
        }

        // Where the listener is now: the transport minus what the device still has to play out.
        juce::var clockState()
        {
            auto o = new juce::DynamicObject();
            if (songEdit == nullptr) return juce::var (o);
            auto& tc = songEdit->getTransport();
            auto* dev = engine.getDeviceManager().deviceManager.getCurrentAudioDevice();
            const double rate = dev ? dev->getCurrentSampleRate() : 48000.0;
            const int latency = dev ? dev->getOutputLatencyInSamples() : 0;
            const double pos = tc.getPosition().inSeconds();
            const double heard = tc.isPlaying() ? juce::jmax (0.0, pos - latency / rate) : pos;
            auto bb = songEdit->tempoSequence.toBarsAndBeats (te::TimePosition::fromSeconds (heard));
            o->setProperty ("playing", tc.isPlaying());
            o->setProperty ("seconds", heard);
            o->setProperty ("sample", (juce::int64) std::llround (heard * rate));
            o->setProperty ("rate", rate);
            o->setProperty ("outLatency", latency);
            o->setProperty ("bar", bb.bars + 1);
            o->setProperty ("beat", bb.beats.inBeats() + 1.0);
            o->setProperty ("monoNs", (juce::int64) (juce::Time::getHighResolutionTicks() * 1.0e9 / (double) juce::Time::getHighResolutionTicksPerSecond()));
            return juce::var (o);
        }

        void tick()
        {
            auto st = clockState();
            const bool playing = (bool) st["playing"];
            if (playing != wasPlaying)
            {
                clock.startTimerHz (playing ? 30 : 2);
                std::cerr << "transport " << (playing ? "started" : "stopped") << " at " << (double) st["seconds"]
                          << " s; edit length " << (songEdit ? songEdit->getLength().inSeconds() : -1.0) << " s" << std::endl;
            }
            wasPlaying = playing;
            proto->event ("clock", st.getDynamicObject());
        }

        // xruns, as they happen
        void timerCallback() override
        {
            auto* dev = engine.getDeviceManager().deviceManager.getCurrentAudioDevice();
            if (dev == nullptr) return;
            const int n = dev->getXRunCount();
            if (n > lastXruns)
            {
                juce::DynamicObject::Ptr o = new juce::DynamicObject();
                o->setProperty ("count", n);
                proto->event ("xrun", o);
            }
            lastXruns = n;
        }
    };

    // doc 15 Q9: the fader jumps from -20 dB to 0 dB at sample 24120 (a peak of the 100 Hz sine, so an unramped jump is
    // a real step), once through our strip with its 20 ms ramp and once without.
    int rampTest (const juce::String& outPath)
    {
        const double rate = 48000;
        const int n = 48000, jump = 24120;
        juce::File out (outPath);
        out.createDirectory();
        for (int ramped = 0; ramped < 2; ++ramped)
        {
            juce::AudioBuffer<float> buf (2, n);
            for (int i = 0; i < n; ++i)
                for (int c = 0; c < 2; ++c) buf.setSample (c, i, (float) (0.5 * std::sin (2.0 * juce::MathConstants<double>::pi * 100.0 * i / rate)));
            mfx::StripState st;
            st.volDb = -20.0;
            st.prepare (rate);
            if (! ramped) st.rampSamples = 0;
            for (int at = 0; at < n; at += 512)
            {
                if (at == (jump / 512) * 512)
                {
                    // the move lands mid-block in a real engine too: process up to it, then the rest
                    const int first = jump - at;
                    st.process (buf.getWritePointer (0, at), buf.getWritePointer (1, at), first, at);
                    st.volDb = 0.0;
                    st.process (buf.getWritePointer (0, jump), buf.getWritePointer (1, jump), juce::jmin (512, n - at) - first, jump);
                    continue;
                }
                st.process (buf.getWritePointer (0, at), buf.getWritePointer (1, at), juce::jmin (512, n - at), at);
            }
            auto file = out.getChildFile (ramped ? "ramped.wav" : "unramped.wav");
            file.deleteFile();
            std::unique_ptr<juce::OutputStream> os (file.createOutputStream().release());
            juce::WavAudioFormat wav;
            auto opts = juce::AudioFormatWriterOptions{}.withSampleRate (rate).withNumChannels (2).withBitsPerSample (32)
                                                        .withSampleFormat (juce::AudioFormatWriterOptions::SampleFormat::floatingPoint);
            auto writer = wav.createWriterFor (os, opts);
            if (writer == nullptr) return 1;
            writer->writeFromAudioSampleBuffer (buf, 0, n);
        }
        return 0;
    }

    int serve()
    {
        auto server = std::make_unique<Server>();
        server->proto->start();
        juce::MessageManager::getInstance()->runDispatchLoop();
        server->proto->stop();
        server->stopTimer();
        server->clock.stopTimer();
        if (server->toneEdit) server->toneEdit->getTransport().stop (false, true);
        if (server->songEdit) server->songEdit->getTransport().stop (false, true);
        server->toneEdit.reset();
        server->songEdit.reset();
        server.reset();
        return 0;
    }
}

int main (int argc, char* argv[])
{
    protoFd = mfx::Protocol::takeStdout();   // first: before JUCE, Tracktion or any plugin can print
    juce::ScopedJuceInitialiser_GUI init;
    juce::StringArray args;
    for (int i = 1; i < argc; ++i)
        args.add (argv[i]);
    if (args.contains ("--version")) return version();
    if (args.contains ("--selftest")) return selftest();
    if (args.contains ("--serve")) return serve();
    if (args.contains ("--ramp-test")) { const int i = args.indexOf ("--ramp-test"); return rampTest (i + 1 < args.size() ? args[i + 1] : "."); }
    if (args.contains ("--render"))
    {
        auto after = [&] (const char* flag) { const int i = args.indexOf (flag); return i >= 0 && i + 1 < args.size() ? args[i + 1] : juce::String(); };
        return renderSong (after ("--render"), after ("--settings"), after ("--out"));
    }
    std::cerr << "mortiflix-engine: --version | --selftest | --serve | --ramp-test <dir> | --render <song.json> --settings <render.json> --out <dir>" << std::endl;
    return 2;
}
