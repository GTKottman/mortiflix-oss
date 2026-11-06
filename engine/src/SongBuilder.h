// The song file (doc 18 §3) → a Tracktion Edit. The studio owns the song; the engine only builds what it says.
// Time: the Edit's time 0 is the song's bar 1 (the studio adds the song's offsetSec to reach video time). Ticks are
// 960 per quarter note, so a tick is 1/960 beat. A channel with no instrument chosen plays Tracktion's 4OSC for now;
// its Strudel sound comes with doc 28 M13 (v48).
#pragma once
#include <JuceHeader.h>
#include "OurPlugins.h"

namespace mfx
{
    namespace te = tracktion;

    inline te::BeatPosition beatsOf (const juce::var& ticks) { return te::BeatPosition::fromBeats ((double) ticks / 960.0); }

    // Our strip (mfx-strip) is the fader and pan; Tracktion's own volume plugin stays at unity: 0 dB, centre, and the
    // linear law, which is 1.0 on both sides at centre (its -3 dB law would take 3 dB off again).
    inline void unityVolumePlugin (te::AudioTrack& t)
    {
        auto v = t.getVolumePlugin();
        v->setPanLaw (te::PanLawLinear);
        v->setVolumeDb (0.0f);
        v->setPan (0.0f);
    }

    // Song automation of a channel's volDb / pan (doc 23 §7) → lanes on the song's sample grid. A link targets
    // { "channel": id, "param" } or { "insert": id, "param" }; v (0–1) maps to min…max in the parameter's unit
    // (curve 0, straight). "single" points run straight to the next point of the same clip (tension is not read yet),
    // "hold" holds. Song-scoped clips play where their playlist items are; "pattern:<id>" ones wherever that pattern plays.
    inline void buildLanes (te::Edit& edit, const juce::var& song, double rate, std::map<juce::String, StripPlugin*>& strips)
    {
        auto samplesAt = [&] (double tick) { return edit.tempoSequence.toTime (te::BeatPosition::fromBeats (tick / 960.0)).inSeconds() * rate; };
        auto* autos = song["automation"].getArray();
        auto* items = song["playlist"]["items"].getArray();
        if (autos == nullptr || items == nullptr) return;
        for (auto& a : *autos)
        {
            auto* pts = a["points"].getArray();
            auto* links = a["links"].getArray();
            if (pts == nullptr || links == nullptr || pts->isEmpty()) continue;
            const auto scope = a.getProperty ("scope", "song").toString();
            for (auto& link : *links)
            {
                const auto target = link["target"];
                const auto param = target["param"].toString();
                const auto key = target.hasProperty ("channel") ? "ch:" + target["channel"].toString() : "in:" + target["insert"].toString();
                auto found = strips.find (key);
                if (found == strips.end() || (param != "volDb" && param != "pan")) continue;
                auto& lane = param == "volDb" ? found->second->state.volLane : found->second->state.panLane;
                const double lo = (double) link.getProperty ("min", 0.0), hi = (double) link.getProperty ("max", 1.0);
                for (auto& it : *items)
                {
                    const bool plays = scope == "song" ? (it["kind"].toString() == "automation" && it["ref"].toString() == a["id"].toString())
                                                       : (it["kind"].toString() == "pattern" && "pattern:" + it["ref"].toString() == scope);
                    if (! plays) continue;
                    const double at = (double) it["at"]["tick"], len = (double) it["len"];
                    for (int k = 0; k < pts->size(); ++k)
                    {
                        const auto& p = pts->getReference (k);
                        const double t = (double) p["tick"];
                        if (t > len) break;
                        const bool last = k + 1 >= pts->size() || (double) pts->getReference (k + 1)["tick"] > len;
                        lane.points.push_back ({ samplesAt (at + t), lo + (double) p["v"] * (hi - lo), ! last && p.getProperty ("shape", "single").toString() != "hold" });
                    }
                }
                std::stable_sort (lane.points.begin(), lane.points.end(), [] (auto& x, auto& y) { return x.at < y.at; });
            }
        }
    }

    struct BuiltSong
    {
        std::unique_ptr<te::Edit> edit;
        int tracks = 0, clips = 0, notes = 0;
        double seconds = 0;
    };

    inline const juce::var* findById (const juce::var& list, const juce::String& id)
    {
        if (auto* a = list.getArray())
            for (auto& v : *a)
                if (v["id"].toString() == id) return &v;
        return nullptr;
    }

    inline void defaultInstrument (te::AudioTrack& track, bool drums)
    {
        auto& edit = track.edit;
        auto plugin = edit.getPluginCache().createNewPlugin (te::FourOscPlugin::xmlTypeName, {});
        track.pluginList.insertPlugin (plugin, 0, nullptr);
        if (auto* osc = dynamic_cast<te::FourOscPlugin*> (plugin.get()))
        {
            if (drums)
            {
                osc->ampSustain->setParameter (0.0f, juce::dontSendNotification);
                osc->ampDecay->setParameter (0.12f, juce::dontSendNotification);
                osc->ampRelease->setParameter (0.05f, juce::dontSendNotification);
            }
        }
    }

    inline BuiltSong buildSong (te::Engine& engine, const juce::var& song)
    {
        BuiltSong out;
        out.edit = te::Edit::createSingleTrackEdit (engine, te::Edit::EditRole::forEditing);
        auto& edit = *out.edit;
        // the master's level (doc 22: the mixer's master volume, 0 dB unless the song says otherwise)
        edit.getMasterVolumePlugin()->setVolumeDb ((float) (double) song["mixer"]["master"].getProperty ("volDb", 0.0));

        // tempo map and meter (the first point at tick 0; jumps or linear ramps after it)
        const juce::var tempoList = song["tempo"], meterList = song["meter"], channelList = song["channels"], itemList = song["playlist"]["items"];
        if (auto* tempo = tempoList.getArray())
        {
            for (int i = 0; i < tempo->size(); ++i)
            {
                const auto& p = tempo->getReference (i);
                const double bpm = (double) p["bpm"];
                if (i == 0) edit.tempoSequence.getTempo (0)->setBpm (bpm);
                else edit.tempoSequence.insertTempo (beatsOf (p["tick"]), bpm, p["shape"].toString() == "linear" ? 1.0f : 0.0f);
            }
        }
        if (auto* meter = meterList.getArray(); meter != nullptr && ! meter->isEmpty())
        {
            auto ts = edit.tempoSequence.getTimeSig (0);
            ts->numerator = (int) (*meter)[0]["num"];
            ts->denominator = (int) (*meter)[0]["den"];
        }

        // one track per channel, in the song's order
        auto* channels = channelList.getArray();
        const int n = channels ? channels->size() : 0;
        edit.ensureNumberOfAudioTracks (juce::jmax (1, n));
        auto tracks = te::getAudioTracks (edit);
        std::map<juce::String, te::AudioTrack*> trackOf;
        std::map<juce::String, StripPlugin*> strips;
        for (int i = 0; i < n; ++i)
        {
            const auto& c = channels->getReference (i);
            auto* t = tracks[i];
            t->setName (c["name"].toString());
            unityVolumePlugin (*t);
            t->setMute ((bool) c.getProperty ("mute", false));
            t->setSolo ((bool) c.getProperty ("solo", false));
            if (! c["instrument"].isObject() || ! (insertVst3Instrument (*t, c["instrument"]) || insertBuiltinInstrument (*t, c["instrument"])))
                defaultInstrument (*t, c["kind"].toString() == "drums");
            // its mixer insert (doc 18 §3.5): built-in effects before the fader, then the track delay (doc 22 §4)
            if (auto* ins = findById (song["mixer"]["inserts"], c["insert"].toString()))
            {
                if (auto* fx = (*ins)["plugins"].getArray())
                    for (auto& entry : *fx)
                        if (auto plugin = createBuiltin (edit, entry))
                            t->pluginList.insertPlugin (plugin, t->pluginList.indexOf (t->getVolumePlugin()), nullptr);
                const int d = (int) std::lround ((double) ins->getProperty ("delayMs", 0.0) * (double) song.getProperty ("sampleRate", 48000.0) / 1000.0);
                if (d != 0)
                {
                    auto v = juce::var (new juce::DynamicObject());
                    v.getDynamicObject()->setProperty ("kind", "builtin");
                    v.getDynamicObject()->setProperty ("name", DelayPlugin::xmlTypeName);
                    v.getDynamicObject()->setProperty (d > 0 ? "delaySamples" : "reportSamples", std::abs (d));
                    t->pluginList.insertPlugin (createBuiltin (edit, v), -1, nullptr);
                }
            }
            // the fader and pan, after the insert's effects
            auto stripPtr = edit.getPluginCache().createNewPlugin (StripPlugin::xmlTypeName, {});
            auto* strip = dynamic_cast<StripPlugin*> (stripPtr.get());
            strip->channelId = c["id"].toString();
            strip->insertId = c["insert"].toString();
            strip->state.volDb = (double) c.getProperty ("volDb", 0.0);
            strip->state.pan = (double) c.getProperty ("pan", 0.0);
            t->pluginList.insertPlugin (stripPtr, t->pluginList.indexOf (t->getVolumePlugin()), nullptr);
            strips["ch:" + strip->channelId] = strip;
            if (strip->insertId.isNotEmpty()) strips["in:" + strip->insertId] = strip;
            trackOf[c["id"].toString()] = t;
            ++out.tracks;
        }

        // the playlist: each pattern item puts a MIDI clip per channel at its tick
        if (auto* items = itemList.getArray())
        {
            for (auto& it : *items)
            {
                if (it["kind"].toString() != "pattern") continue;
                auto* pat = findById (song["patterns"], it["ref"].toString());
                if (pat == nullptr) continue;
                const auto at = beatsOf (it["at"]["tick"]);
                const double lenBeats = (double) it["len"] / 960.0;
                const juce::var notesVar = (*pat)["notes"];
                auto* notes = notesVar.getDynamicObject();
                if (notes == nullptr) continue;
                for (auto& prop : notes->getProperties())
                {
                    auto found = trackOf.find (prop.name.toString());
                    if (found == trackOf.end()) continue;
                    auto* list = prop.value.getArray();
                    if (list == nullptr || list->isEmpty()) continue;
                    // a note ringing past the section's end is kept whole: the clip runs to its end
                    double endBeats = lenBeats;
                    for (auto& nt : *list) endBeats = juce::jmax (endBeats, ((double) nt["t"] + (double) nt["len"]) / 960.0);
                    const auto t0 = edit.tempoSequence.toTime (at);
                    const auto t1 = edit.tempoSequence.toTime (at + te::BeatDuration::fromBeats (endBeats));
                    auto clip = found->second->insertMIDIClip ((*pat)["id"].toString(), te::TimeRange (t0, t1), nullptr);
                    if (clip == nullptr) continue;
                    auto& seq = clip->getSequence();
                    for (auto& nt : *list)
                    {
                        const int key = (int) nt["key"];
                        const double vel = (double) nt.getProperty ("vel", 0.8);
                        seq.addNote (key, beatsOf (nt["t"]), te::BeatDuration::fromBeats ((double) nt["len"] / 960.0),
                                     juce::jlimit (1, 127, (int) std::lround (vel * 127.0)), 0, nullptr);
                        ++out.notes;
                    }
                    ++out.clips;
                    out.seconds = juce::jmax (out.seconds, t1.inSeconds());
                }
            }
        }
        buildLanes (edit, song, (double) song.getProperty ("sampleRate", 48000.0), strips);
        return out;
    }
}
