# mortiflix-engine: the mini DAW's sound engine (doc 16). JUCE + Tracktion Engine, driven by the studio over stdio.
# Licence: AGPL-3.0-only (Mortiflix), combined with JUCE (AGPLv3) and Tracktion Engine (GPLv3+): GPLv3 §13 / AGPLv3 §13.
cmake_minimum_required(VERSION 3.22)
project(mortiflix_engine VERSION 0.1.0 LANGUAGES C CXX)

# The pinned tracktion_engine checkout (with its JUCE submodule): see deps.json. setup daw-engine --build passes it.
set(TE_DIR "$ENV{HOME}/.cache/mortiflix/engine-deps/tracktion_engine" CACHE PATH "tracktion_engine checkout")
if(NOT EXISTS "${TE_DIR}/modules/juce/CMakeLists.txt")
  message(FATAL_ERROR "No tracktion_engine at ${TE_DIR} (with modules/juce): fetch the commits in deps.json")
endif()

# Our fixes to the pinned checkout (patches/*.patch, in name order), applied once: a patch that is already in is left
# alone, one that fits neither way stops the build.
find_package(Git REQUIRED)
file(GLOB TE_PATCHES "${CMAKE_CURRENT_SOURCE_DIR}/patches/*.patch")
list(SORT TE_PATCHES)
foreach(patch IN LISTS TE_PATCHES)
  get_filename_component(patch_name "${patch}" NAME)
  execute_process(COMMAND "${GIT_EXECUTABLE}" apply --check --reverse "${patch}" WORKING_DIRECTORY "${TE_DIR}"
                  RESULT_VARIABLE already OUTPUT_QUIET ERROR_QUIET)
  if(already EQUAL 0)
    message(STATUS "patch ${patch_name}: already applied")
  else()
    execute_process(COMMAND "${GIT_EXECUTABLE}" apply "${patch}" WORKING_DIRECTORY "${TE_DIR}" RESULT_VARIABLE failed ERROR_VARIABLE why)
    if(NOT failed EQUAL 0)
      message(FATAL_ERROR "patch ${patch_name} doesn't fit the tracktion_engine checkout at ${TE_DIR}: ${why}")
    endif()
    message(STATUS "patch ${patch_name}: applied")
  endif()
endforeach()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_subdirectory("${TE_DIR}/modules/juce" juce)
add_subdirectory("${TE_DIR}/modules" tracktion)

juce_add_console_app(mortiflix-engine
  PRODUCT_NAME "mortiflix-engine"
  NEEDS_CURL FALSE
  NEEDS_WEB_BROWSER FALSE)
juce_generate_juce_header(mortiflix-engine)

target_sources(mortiflix-engine PRIVATE src/Main.cpp)

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/deps.json" DEPS_JSON)
string(JSON TE_COMMIT GET "${DEPS_JSON}" tracktion_engine commit)
string(JSON JUCE_COMMIT GET "${DEPS_JSON}" juce commit)

target_compile_definitions(mortiflix-engine PRIVATE
  MFX_ENGINE_VERSION="${PROJECT_VERSION}"
  MFX_TE_COMMIT="${TE_COMMIT}"
  MFX_JUCE_COMMIT="${JUCE_COMMIT}"
  JUCE_JACK=1
  JUCE_ALSA=1
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_LADSPA=0
  JUCE_PLUGINHOST_AU=0
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_STRICT_REFCOUNTEDPOINTER=1
  JUCE_MODAL_LOOPS_PERMITTED=1
  JUCE_DISPLAY_SPLASH_SCREEN=0
  TRACKTION_LOG_DEVICES=0)

target_link_libraries(mortiflix-engine PRIVATE
  tracktion::tracktion_core
  tracktion::tracktion_engine
  tracktion::tracktion_graph
  juce::juce_audio_devices
  juce::juce_audio_processors
  juce::juce_audio_utils
  juce::juce_cryptography
  juce::juce_recommended_config_flags)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_libraries(mortiflix-engine PRIVATE atomic)
endif()
# Release: -O2, never -ffast-math (it would break denormal and NaN handling the audio code relies on).
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(mortiflix-engine PRIVATE -Wno-unknown-pragmas "$<$<CONFIG:Release>:-O2>")
endif()
