Pod::Spec.new do |s|
  s.name           = 'PaseoLiveActivity'
  s.version        = '0.1.0'
  s.summary        = 'Live Activity of busy bots (ActivityKit tokens, local start/update/end)'
  s.description    = 'Live Activity of busy bots (ActivityKit tokens, local start/update/end)'
  s.license        = 'Apache-2.0'
  s.author         = 'Paseo'
  s.homepage       = 'https://paseo.sh'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.weak_frameworks = 'ActivityKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
