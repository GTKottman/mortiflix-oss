// Our built-in plugins. A song names one as { "kind": "builtin", "name": "mfx-…", …its settings }.
//   mfx-click   test instrument (doc 15 §4 timing tests): one sample at the note's velocity (vel / 127) on both sides,
//               on the note-on's own sample; nothing else, so the tests can compute every sample on their own.
//   mfx-delay   a delay in whole samples that reports its own latency, separately ("delaySamples", "reportSamples",
//               "gain"): track delay (doc 22 §4: + delays the track, − reports latency so PDC delays all the others)
//               and the delay-compensation tests (doc 15 Q7: a plugin that delays 512 and says so).
//   mfx-dc      test source: a constant level ("level", default 0.5) on both sides, so a gain curve can be read off
//               every sample (doc 15 Q27).
//   mfx-strip   every track's fader and pan (doc 15 A7, doc 22): the -3 dB constant-power pan law, live moves ramped per
//               sample over 20 ms (in dB for the fader, along a raised-cosine curve), and song automation of volDb / pan
//               worked out per sample on the song's own sample grid, so nothing depends on the block size (Q9, Q27).
//               Tracktion's own volume plugin is left at unity.
#pragma once
#include <JuceHeader.h>

namespace mfx
{
    namespace te = tracktion;

    class ClickPlugin : public te::Plugin
    {
    public:
        explicit ClickPlugin (te::PluginCreationInfo info) : te::Plugin (info) {}
        ~ClickPlugin() override { notifyListenersOfDeletion(); }

        static const char* getPluginName() { return "mfx-click"; }
        static inline const char* xmlTypeName = "mfx-click";
        juce::String getName() const override { return getPluginName(); }
        juce::String getPluginType() override { return xmlTypeName; }
        juce::String getShortName (int) override { return getName(); }
        juce::String getSelectableDescription() override { return getName(); }
        bool isSynth() override { return true; }
        bool takesMidiInput() override { return true; }
        bool producesAudioWhenNoAudioInput() override { return true; }
        int getNumOutputChannelsGivenInputs (int) override { return 2; }
        BusLayout getBusses() const override { return BusLayout::singleStereoInOut(); }

        void initialise (const te::PluginInitialisationInfo&) override { carried.clear(); }
        void deinitialise() override {}
        void reset() override { carried.clear(); }

        void applyToBuffer (const te::PluginRenderContext& fc) override
        {
            if (fc.destBuffer == nullptr) return;
            const double rate = sampleRate;
            const int n = fc.bufferNumSamples;
            fc.destBuffer->clear (fc.bufferStartSample, n);
            // The block's first sample on the song's sample grid; each event lands at its own sample, and one that
            // rounds to this block's end is carried into the next block (never pulled back onto this block's last
            // sample, which would move it by one depending on the block size).
            const juce::int64 blockStart = std::llround (fc.editTime.getStart().inSeconds() * rate);
            auto put = [&] (juce::int64 at, float v)
            {
                const auto i = at - blockStart;
                if (i < 0 || i >= n) { if (i >= n) carried.push_back ({ at, v }); return; }
                for (int c = 0; c < fc.destBuffer->getNumChannels(); ++c)
                    fc.destBuffer->addSample (c, fc.bufferStartSample + (int) i, v);
            };
            auto waiting = std::move (carried);
            carried.clear();
            for (auto& [at, v] : waiting) put (at, v);
            // The note's own time on the song's sample grid, rounded once; a note exactly on a half sample always goes to
            // the later one (+1e-6 sample, far under any real difference), so float error in the block's start can't
            // flip it with the block size.
            const double start = fc.editTime.getStart().inSeconds();
            if (fc.bufferForMidiMessages != nullptr)
                for (auto& m : *fc.bufferForMidiMessages)
                    if (m.isNoteOn())
                        put (std::llround ((start + m.getTimeStamp()) * rate + 1.0e-6), m.getVelocity() / 127.0f);
        }

    private:
        std::vector<std::pair<juce::int64, float>> carried;
    };

    class DelayPlugin : public te::Plugin
    {
    public:
        explicit DelayPlugin (te::PluginCreationInfo info) : te::Plugin (info) {}
        ~DelayPlugin() override { notifyListenersOfDeletion(); }

        static const char* getPluginName() { return "mfx-delay"; }
        static inline const char* xmlTypeName = "mfx-delay";
        juce::String getName() const override { return getPluginName(); }
        juce::String getPluginType() override { return xmlTypeName; }
        juce::String getShortName (int) override { return getName(); }
        juce::String getSelectableDescription() override { return getName(); }
        BusLayout getBusses() const override { return BusLayout::singleStereoInOut(); }
        int getNumOutputChannelsGivenInputs (int) override { return 2; }
        double getLatencySeconds() override { return sampleRate > 0 ? reportSamples / sampleRate : 0.0; }

        // set once, before the Edit plays (the song is built again for any change)
        int delaySamples = 0, reportSamples = 0;
        float gain = 1.0f;

        void initialise (const te::PluginInitialisationInfo&) override { reset(); }
        void deinitialise() override {}
        void reset() override
        {
            line.setSize (2, juce::jmax (1, delaySamples + 1));
            line.clear();
            pos = 0;
        }

        void applyToBuffer (const te::PluginRenderContext& fc) override
        {
            if (fc.destBuffer == nullptr) return;
            auto& b = *fc.destBuffer;
            const int chans = juce::jmin (2, b.getNumChannels());
            if (delaySamples > 0)
            {
                const int size = line.getNumSamples();
                for (int i = 0; i < fc.bufferNumSamples; ++i)
                {
                    const int r = (pos + size - delaySamples) % size;
                    for (int c = 0; c < chans; ++c)
                    {
                        auto* d = b.getWritePointer (c, fc.bufferStartSample);
                        line.setSample (c, pos, d[i]);
                        d[i] = line.getSample (c, r);
                    }
                    pos = (pos + 1) % size;
                }
            }
            if (gain != 1.0f)
                for (int c = 0; c < chans; ++c) b.applyGain (c, fc.bufferStartSample, fc.bufferNumSamples, gain);
        }

    private:
        juce::AudioBuffer<float> line;
        int pos = 0;
    };

    class DcPlugin : public te::Plugin
    {
    public:
        explicit DcPlugin (te::PluginCreationInfo info) : te::Plugin (info) {}
        ~DcPlugin() override { notifyListenersOfDeletion(); }
        static const char* getPluginName() { return "mfx-dc"; }
        static inline const char* xmlTypeName = "mfx-dc";
        juce::String getName() const override { return getPluginName(); }
        juce::String getPluginType() override { return xmlTypeName; }
        juce::String getShortName (int) override { return getName(); }
        juce::String getSelectableDescription() override { return getName(); }
        bool isSynth() override { return true; }
        bool takesMidiInput() override { return true; }
        bool producesAudioWhenNoAudioInput() override { return true; }
        int getNumOutputChannelsGivenInputs (int) override { return 2; }
        BusLayout getBusses() const override { return BusLayout::singleStereoInOut(); }
        void initialise (const te::PluginInitialisationInfo&) override {}
        void deinitialise() override {}
        float level = 0.5f;
        void applyToBuffer (const te::PluginRenderContext& fc) override
        {
            if (fc.destBuffer == nullptr) return;
            for (int c = 0; c < fc.destBuffer->getNumChannels(); ++c)
                juce::FloatVectorOperations::fill (fc.destBuffer->getWritePointer (c, fc.bufferStartSample), level, fc.bufferNumSamples);
        }
    };

    // ---- the fader and pan (mfx-strip) ----

    // A value moving to its target over a set number of samples along a raised-cosine curve (no corner where it starts
    // or stops). A straight line in dB over 20 ms leaves -73 dBFS above 5 kHz on a -20 → 0 dB jump; this curve leaves
    // -118 dBFS (doc 15 Q9 asks for -90). A new target mid-way starts a new curve from where it is.
    struct Ramp
    {
        double cur = 0, from = 0, target = 0;
        int n = 0, k = 0;
        void set (double v) { cur = from = target = v; n = k = 0; }
        void to (double v, int samples) { target = v; if (samples <= 0) { cur = v; n = k = 0; return; } from = cur; n = samples; k = 0; }
        double next()
        {
            if (k < n)
            {
                ++k;
                cur = k == n ? target : from + (target - from) * (0.5 - 0.5 * std::cos (juce::MathConstants<double>::pi * k / n));
            }
            return cur;
        }
    };

    // An automation lane on the song's sample grid: points in samples, each either a straight line to the next or held.
    struct Lane
    {
        struct Point { double at; double v; bool lineToNext; };
        std::vector<Point> points;   // sorted by `at`
        bool empty() const { return points.empty(); }
        // the value at sample s, or false before the first point
        bool valueAt (double s, double& v) const
        {
            if (points.empty() || s < points.front().at) return false;
            auto it = std::upper_bound (points.begin(), points.end(), s, [] (double x, const Point& p) { return x < p.at; });
            const auto& a = *(it - 1);
            if (it == points.end() || ! a.lineToNext || it->at <= a.at) { v = a.v; return true; }
            v = a.v + (it->v - a.v) * (s - a.at) / (it->at - a.at);
            return true;
        }
    };

    inline constexpr double floorDb = -144.0;
    inline void panGains (double pan, double& l, double& r)
    {
        const double p = (juce::jlimit (-1.0, 1.0, pan) + 1.0) * 0.5;
        l = std::sin ((1.0 - p) * juce::MathConstants<double>::halfPi);
        r = std::sin (p * juce::MathConstants<double>::halfPi);
    }

    // Everything the strip needs to process, apart from Tracktion: also used by --ramp-test.
    struct StripState
    {
        std::atomic<double> volDb { 0.0 }, pan { 0.0 };   // set from the message thread (song, mixer.set)
        Ramp vol, panRamp;
        double lastVolTarget = 0, lastPanTarget = 0;
        int rampSamples = 960;                               // 20 ms at 48 kHz
        Lane volLane, panLane;

        void prepare (double rate)
        {
            rampSamples = (int) std::lround (0.020 * rate);
            vol.set (lastVolTarget = volDb.load());
            panRamp.set (lastPanTarget = pan.load());
        }
        // n samples of L / R starting at the song's sample `at`
        void process (float* l, float* r, int n, juce::int64 at)
        {
            const double vt = volDb.load(), pt = pan.load();
            if (vt != lastVolTarget) { vol.to (lastVolTarget = vt, rampSamples); }
            if (pt != lastPanTarget) { panRamp.to (lastPanTarget = pt, rampSamples); }
            for (int i = 0; i < n; ++i)
            {
                const double s = (double) (at + i);
                double db = vol.next(), p = panRamp.next(), v;
                if (volLane.valueAt (s, v)) db = v;
                if (panLane.valueAt (s, v)) p = v;
                const double g = db <= floorDb ? 0.0 : std::pow (10.0, db / 20.0);
                double gl, gr;
                panGains (p, gl, gr);
                if (l != nullptr) l[i] = (float) (l[i] * g * gl);
                if (r != nullptr) r[i] = (float) (r[i] * g * gr);
            }
        }
    };

    class StripPlugin : public te::Plugin
    {
    public:
        explicit StripPlugin (te::PluginCreationInfo info) : te::Plugin (info) {}
        ~StripPlugin() override { notifyListenersOfDeletion(); }
        static const char* getPluginName() { return "mfx-strip"; }
        static inline const char* xmlTypeName = "mfx-strip";
        juce::String getName() const override { return getPluginName(); }
        juce::String getPluginType() override { return xmlTypeName; }
        juce::String getShortName (int) override { return getName(); }
        juce::String getSelectableDescription() override { return getName(); }
        BusLayout getBusses() const override { return BusLayout::singleStereoInOut(); }
        int getNumOutputChannelsGivenInputs (int) override { return 2; }

        juce::String channelId, insertId;
        StripState state;

        void initialise (const te::PluginInitialisationInfo& info) override { state.prepare (info.sampleRate); }
        void deinitialise() override {}
        void applyToBuffer (const te::PluginRenderContext& fc) override
        {
            if (fc.destBuffer == nullptr) return;
            auto& b = *fc.destBuffer;
            const juce::int64 at = std::llround (fc.editTime.getStart().inSeconds() * sampleRate);
            state.process (b.getWritePointer (0, fc.bufferStartSample), b.getNumChannels() > 1 ? b.getWritePointer (1, fc.bufferStartSample) : nullptr,
                           fc.bufferNumSamples, at);
        }
    };

    // Called once per te::Engine, before any song is built.
    inline void registerOurPlugins (te::Engine& engine)
    {
        engine.getPluginManager().createBuiltInType<ClickPlugin>();
        engine.getPluginManager().createBuiltInType<DelayPlugin>();
        engine.getPluginManager().createBuiltInType<DcPlugin>();
        engine.getPluginManager().createBuiltInType<StripPlugin>();
    }

    // A built-in plugin entry → its plugin, set from the entry (nullptr when it isn't one of ours or Tracktion's).
    inline te::Plugin::Ptr createBuiltin (te::Edit& edit, const juce::var& entry)
    {
        if (entry["kind"].toString() != "builtin") return {};
        auto plugin = edit.getPluginCache().createNewPlugin (entry["name"].toString(), {});
        if (auto* d = dynamic_cast<DelayPlugin*> (plugin.get()))
        {
            d->delaySamples = juce::jmax (0, (int) entry.getProperty ("delaySamples", 0));
            d->reportSamples = juce::jmax (0, (int) entry.getProperty ("reportSamples", 0));
            d->gain = (float) (double) entry.getProperty ("gain", 1.0);
        }
        if (auto* dc = dynamic_cast<DcPlugin*> (plugin.get()))
            dc->level = (float) (double) entry.getProperty ("level", 0.5);
        return plugin;
    }

    // A channel's { "kind": "builtin", "name": … } → that plugin as its instrument (true), or false.
    inline bool insertBuiltinInstrument (te::AudioTrack& track, const juce::var& entry)
    {
        auto plugin = createBuiltin (track.edit, entry);
        if (plugin == nullptr) return false;
        track.pluginList.insertPlugin (plugin, 0, nullptr);
        return true;
    }

    // A VST3 instrument by its path (owner, 2026-10-23: Surge XT plays scoring packs' parts):
    //   { "kind": "vst3", "path": ".../Surge XT.vst3", "surgePatch": ".../Patch.fxp" }
    // A Surge patch file is a 60-byte fxp header and then the patch itself, which is exactly the state Surge saves and
    // loads; it goes to the plugin the way JUCE hosts a VST3's state (its component state inside JUCE's binary XML).
    inline bool insertVst3Instrument (te::AudioTrack& track, const juce::var& entry)
    {
        if (entry["kind"].toString() != "vst3") return false;
        const juce::File bundle (entry["path"].toString());
        if (! bundle.exists()) { std::cerr << "no VST3 at " << bundle.getFullPathName() << std::endl; return false; }
        auto& engine = track.edit.engine;
        juce::VST3PluginFormat format;
        juce::OwnedArray<juce::PluginDescription> types;
        format.findAllTypesForFile (types, bundle.getFullPathName());
        const juce::PluginDescription* desc = nullptr;
        for (auto* d : types) if (d->isInstrument) { desc = d; break; }
        if (desc == nullptr && ! types.isEmpty()) desc = types[0];
        if (desc == nullptr) { std::cerr << "the VST3 has no plugin in it: " << bundle.getFullPathName() << std::endl; return false; }
        engine.getPluginManager().knownPluginList.addType (*desc);
        auto plugin = track.edit.getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, *desc);
        if (plugin == nullptr) return false;
        track.pluginList.insertPlugin (plugin, 0, nullptr);
        auto* ext = dynamic_cast<te::ExternalPlugin*> (plugin.get());
        if (ext == nullptr) return false;
        ext->initialiseFully();
        auto* instance = ext->getAudioPluginInstance();
        if (instance == nullptr) { std::cerr << "the VST3 didn't load: " << bundle.getFullPathName() << std::endl; return false; }
        if (entry.hasProperty ("surgePatch"))
        {
            juce::MemoryBlock fxp;
            if (! juce::File (entry["surgePatch"].toString()).loadFileAsData (fxp) || fxp.getSize() <= 60)
            { std::cerr << "no Surge patch at " << entry["surgePatch"].toString() << std::endl; return false; }
            juce::MemoryBlock patch (static_cast<const char*> (fxp.getData()) + 60, fxp.getSize() - 60);
            juce::XmlElement state ("VST3PluginState");
            state.createNewChildElement ("IComponent")->addTextElement (patch.toBase64Encoding());
            juce::MemoryBlock blob;
            juce::AudioProcessor::copyXmlToBinary (state, blob);
            instance->setStateInformation (blob.getData(), (int) blob.getSize());
        }
        return true;
    }
}
