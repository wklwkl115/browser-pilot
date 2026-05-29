(module
  (import "env" "log" (func $log (param i32)))
  (memory (export "memory") 1)
  (func (export "run")
    i32.const 0
    call $log)
)
