	package main

	import (
		"archive/zip"
		"bufio"
		"bytes"
		"context"
		"encoding/json"
		"encoding/xml"
		"fmt"
		"io"
		"log"
		"net/http"
		"os"
		"regexp"
		"runtime"
		"strconv"
		"strings"
		"sync"
		"sync/atomic"
		"time"

		"github.com/gofiber/fiber/v2"
		"github.com/gofiber/fiber/v2/middleware/cors"
		"github.com/gofiber/fiber/v2/middleware/logger"
		"github.com/jackc/pgx/v5"
		"github.com/jackc/pgx/v5/pgxpool"
		"github.com/joho/godotenv"
		"github.com/xuri/excelize/v2"
	)

	// ============================================================================
	// CONFIGURACIÓN Y VARIABLES GLOBALES
	// ============================================================================

	var (
		dbPool             *pgxpool.Pool
		backendURL         string
		activeProcesses    = make(map[int]*ProcessStatus)
		activeProcessMux   sync.RWMutex
		cancelledProcesses = make(map[int]bool) // Procesos marcados como cancelados
		cancelledMux       sync.RWMutex
	)

	type ProcessStatus struct {
		ExcelID   int     `json:"excelId"`
		Filename  string  `json:"filename"`
		Progress  float64 `json:"progress"`
		Total     int     `json:"total"`
		Processed int     `json:"processed"`
		Status    string  `json:"status"`
		Message   string  `json:"message"`
	}

	// ============================================================================
	// HELPERS DE ESTADO
	// ============================================================================

	func updateActiveProcess(userID int, status *ProcessStatus) {
		activeProcessMux.Lock()
		defer activeProcessMux.Unlock()
		activeProcesses[userID] = status
	}

	func getActiveProcess(userID int) *ProcessStatus {
		activeProcessMux.RLock()
		defer activeProcessMux.RUnlock()
		return activeProcesses[userID]
	}

	func deleteActiveProcess(userID int) {
		activeProcessMux.Lock()
		defer activeProcessMux.Unlock()
		delete(activeProcesses, userID)
	}

	// Marcar proceso como cancelado
	func setCancelledProcess(excelID int) {
		cancelledMux.Lock()
		defer cancelledMux.Unlock()
		cancelledProcesses[excelID] = true
	}

	// Verificar si proceso está cancelado
	func isProcessCancelled(excelID int) bool {
		cancelledMux.RLock()
		defer cancelledMux.RUnlock()
		return cancelledProcesses[excelID]
	}

	// Limpiar estado de cancelación
	func clearCancelledProcess(excelID int) {
		cancelledMux.Lock()
		defer cancelledMux.Unlock()
		delete(cancelledProcesses, excelID)
	}

// ============================================================================
// FORMATEO DE NÚMEROS (máximo 2 decimales)
// ============================================================================

// formatNumber formatea números con máximo 2 decimales
// Convierte notación científica a formato normal
func formatNumber(value string) string {
	// Intentar parsear como float
	f, err := strconv.ParseFloat(value, 64)
	if err != nil {
		// No es un número, devolver tal cual
		return value
	}
	
	// Si es un entero (sin decimales), devolver sin decimales
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	
	// Formatear con máximo 2 decimales
	formatted := strconv.FormatFloat(f, 'f', 2, 64)
	
	// Eliminar ceros trailing después del punto decimal
	if strings.Contains(formatted, ".") {
		formatted = strings.TrimRight(formatted, "0")
		formatted = strings.TrimRight(formatted, ".")
	}
	
	return formatted
}

// ============================================================================
// NOTIFICACIÓN HTTP (Simple y confiable)
// ============================================================================

func notifyProgress(excelID, userID int, status *ProcessStatus) {
		// Actualizar estado local
		updateActiveProcess(userID, status)

		// Notificar al backend via HTTP POST (sin autenticación, endpoint público interno)
		go func() {
			payload := map[string]interface{}{
				"excelId":   excelID,
				"userId":    userID,
				"progress":  status.Progress,
				"total":     status.Total,
				"processed": status.Processed,
				"status":    status.Status,
				"message":   status.Message,
				"filename":  status.Filename,
			}

			jsonData, _ := json.Marshal(payload)

			req, err := http.NewRequest("POST", backendURL+"/excel/notify-progress", bytes.NewBuffer(jsonData))
			if err != nil {
				return
			}

			req.Header.Set("Content-Type", "application/json")

			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				log.Printf("⚠️ Error notificando: %v", err)
				return
			}
			defer resp.Body.Close()

			if resp.StatusCode == 200 || resp.StatusCode == 201 {
				log.Printf("📡 Notificado: Excel %d - %s (%.1f%%)", excelID, status.Status, status.Progress)
			} else {
				log.Printf("⚠️ Error respuesta: %d", resp.StatusCode)
			}
		}()
	}

	// ============================================================================
	// PROCESAMIENTO DE EXCEL
	// ============================================================================

	func processExcel(c *fiber.Ctx) error {
		// Obtener parámetros
		userIDStr := c.FormValue("user_id")
		uploadedBy := c.FormValue("uploaded_by")
		existingExcelID := c.FormValue("excel_id") // ⚡ Excel ID existente (de NestJS)

		userID, err := strconv.Atoi(userIDStr)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "user_id inválido"})
		}

		// Obtener archivo
		file, err := c.FormFile("file")
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "No se recibió archivo"})
		}

		filename := file.Filename
		if !strings.HasSuffix(strings.ToLower(filename), ".xlsx") && !strings.HasSuffix(strings.ToLower(filename), ".xls") {
			return c.Status(400).JSON(fiber.Map{"error": "El archivo debe ser Excel (.xlsx o .xls)"})
		}

		// ⚡ MODO DIRECTO: Si viene de NestJS (con excel_id), procesar directamente sin pausar
		skipHeaderSelection := existingExcelID != ""

		log.Printf("📊 Procesando archivo: %s para usuario %d (modo directo: %v)", filename, userID, skipHeaderSelection)

		// PASO 1: Obtener o crear metadata
		ctx := context.Background()
		var excelID int
		
		if existingExcelID != "" {
			excelID, err = strconv.Atoi(existingExcelID)
			if err != nil {
				return c.Status(400).JSON(fiber.Map{"error": "excel_id inválido"})
			}
			log.Printf("♻️ Usando Excel ID existente: %d (cabeceras ya seleccionadas en NestJS)", excelID)
		} else {
			// Crear metadata nueva (modo legacy - sin NestJS)
			err = dbPool.QueryRow(ctx, `
				INSERT INTO excel_metadata (user_id, filename, "totalRecords", "uploadedBy", headers, "isReactive", "uploadedAt")
				VALUES ($1, $2, 0, $3, '[]'::json, true, NOW())
				RETURNING id
			`, userID, filename, uploadedBy).Scan(&excelID)

			if err != nil {
				log.Printf("❌ Error creando metadata: %v", err)
				return c.Status(500).JSON(fiber.Map{"error": "Error creando metadata"})
			}
			log.Printf("💾 Metadata creada (ID: %d)", excelID)
		}

		// PASO 2: Notificar inicio
		status := &ProcessStatus{
			ExcelID:  excelID,
			Filename: filename,
			Status:   "uploading",
			Message:  "Recibiendo archivo...",
		}
		notifyProgress(excelID, userID, status)

		// PASO 3: Guardar archivo temporalmente
		tempFile, err := os.CreateTemp("", "excel-*.xlsx")
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Error creando archivo temporal"})
		}
		tempPath := tempFile.Name()

		src, _ := file.Open()
		io.Copy(tempFile, src)
		src.Close()
		tempFile.Close()

		fileInfo, _ := os.Stat(tempPath)
		fileSizeMB := float64(fileInfo.Size()) / (1024 * 1024)
		log.Printf("📏 Archivo guardado: %.2f MB", fileSizeMB)

		status.Status = "saved"
		status.Message = fmt.Sprintf("Archivo guardado (%.1f MB)", fileSizeMB)
		notifyProgress(excelID, userID, status)

		// PASO 4: Procesar en background
		// ⚡ Pasar flag para indicar si debe saltar la selección de cabeceras
		go processExcelInBackgroundDirect(excelID, userID, filename, uploadedBy, tempPath, fileSizeMB, skipHeaderSelection)

		// PASO 5: Responder inmediatamente
		log.Printf("✅ Excel %d: Respondiendo inmediatamente, procesando en background", excelID)
		return c.JSON(fiber.Map{
			"success":      true,
			"message":      "Excel recibido, procesando en background",
			"excelId":      excelID,
			"recordsCount": 0,
		})
	}

	// ⚡ PROCESAMIENTO ULTRA RÁPIDO - LECTURA DIRECTA DEL ZIP
	func processExcelInBackgroundDirect(excelID, userID int, filename, uploadedBy, tempPath string, fileSizeMB float64, skipHeaderSelection bool) {
		startTime := time.Now()
		defer os.Remove(tempPath)

		// ⚡ Usar todos los CPUs disponibles
		runtime.GOMAXPROCS(runtime.NumCPU())

		// Helper para notificar
		notify := func(status, message string, progress float64, total, processed int) {
			notifyProgress(excelID, userID, &ProcessStatus{
				ExcelID:   excelID,
				Filename:  filename,
				Status:    status,
				Message:   message,
				Progress:  progress,
				Total:     total,
				Processed: processed,
			})
		}

		notify("reading", fmt.Sprintf("Abriendo Excel (%.1f MB)...", fileSizeMB), 0, 0, 0)

		// ⚡ LECTURA DIRECTA DEL ZIP - Mucho más rápido que excelize
		headers, allRows, err := readExcelDirectFromZip(tempPath, func(count int) {
			if count%50000 == 0 {
				log.Printf("📖 Leyendo... %d filas", count)
			}
		})
		
		if err != nil {
			log.Printf("❌ Error leyendo Excel: %v", err)
			// Fallback a excelize si falla la lectura directa
			log.Printf("⚠️ Intentando con excelize como fallback...")
			headers, allRows, err = readExcelWithExcelize(tempPath)
			if err != nil {
				notify("error", "Error leyendo Excel: "+err.Error(), 0, 0, 0)
				deleteActiveProcess(userID)
				return
			}
		}

		notify("reading", "Leyendo datos del Excel...", 5, 0, 0)

		if len(headers) == 0 {
			notify("error", "El Excel no tiene cabeceras", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}

		log.Printf("📊 Headers: %d columnas", len(headers))

		rowCount := len(allRows)
		readTime := time.Since(startTime)
		log.Printf("📋 Excel leído en %.2fs: %d filas", readTime.Seconds(), rowCount)

		if rowCount == 0 {
			notify("error", "El Excel no contiene datos", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}

		notify("processing", fmt.Sprintf("Excel leído: %d filas en %.1fs", rowCount, readTime.Seconds()), 10, rowCount, 0)

		// ⚡ Convertir filas a registros usando todos los CPUs
		records := processRowsParallel(allRows, headers)

		log.Printf("📊 Registros válidos: %d", len(records))

		if len(records) == 0 {
			notify("error", "El Excel no contiene datos válidos", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}

		// Actualizar metadata (solo totalRecords, los headers ya fueron guardados por el backend de NestJS)
		ctx := context.Background()
		dbPool.Exec(ctx, `
			UPDATE excel_metadata 
			SET "totalRecords" = $1
			WHERE id = $2
		`, len(records), excelID)

		notify("inserting", fmt.Sprintf("Insertando %d registros...", len(records)), 15, len(records), 0)

		// Insertar registros
		insertRecordsOptimized(ctx, excelID, userID, records, filename)

		// Completado
		elapsed := time.Since(startTime)
		log.Printf("✅ Excel %d completado: %d registros en %.2fs", excelID, len(records), elapsed.Seconds())
		notify("completed", fmt.Sprintf("✅ Completado: %d registros en %.1fs", len(records), elapsed.Seconds()), 100, len(records), len(records))

		// Limpiar
		time.Sleep(3 * time.Second)
		deleteActiveProcess(userID)
	}

	func processExcelInBackground(excelID, userID int, filename, uploadedBy, tempPath string, fileSizeMB float64) {
		startTime := time.Now()
		defer os.Remove(tempPath)

		// Helper para notificar
		notify := func(status, message string, progress float64, total, processed int) {
			notifyProgress(excelID, userID, &ProcessStatus{
				ExcelID:   excelID,
				Filename:  filename,
				Status:    status,
				Message:   message,
				Progress:  progress,
				Total:     total,
				Processed: processed,
			})
		}

		// Notificar inicio de lectura
		notify("reading", fmt.Sprintf("Abriendo Excel (%.1f MB)...", fileSizeMB), 0, 0, 0)

		// Abrir Excel con opciones optimizadas
		f, err := excelize.OpenFile(tempPath, excelize.Options{
			UnzipSizeLimit:    10 << 30,          // 10GB
			UnzipXMLSizeLimit: 10 << 30,          // 10GB
			Password:          "",                 // Sin password
			RawCellValue:      false,             // Parsear valores
			ShortDatePattern:  "yyyy-mm-dd",      // Formato de fecha
		})
		if err != nil {
			log.Printf("❌ Error abriendo Excel: %v", err)
			notify("error", "Error abriendo Excel: "+err.Error(), 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}
		defer f.Close()

		sheets := f.GetSheetList()
		if len(sheets) == 0 {
			notify("error", "El Excel no tiene hojas", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}
		sheetName := sheets[0]

		// Notificar que está leyendo
		notify("reading", "Leyendo datos del Excel...", 5, 0, 0)

		// Leer todas las filas de una vez (MÁS RÁPIDO que streaming)
		// GetRows es más rápido que streaming para archivos completos
		rows, err := f.GetRows(sheetName, excelize.Options{
			RawCellValue: false, // Obtener valores formateados
		})
		if err != nil {
			log.Printf("❌ Error leyendo filas: %v", err)
			notify("error", "Error leyendo filas", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}

		if len(rows) < 2 {
			notify("error", "El Excel no contiene datos", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}

		readTime := time.Since(startTime)
		log.Printf("📋 Excel leído en %.2fs: %d filas", readTime.Seconds(), len(rows))

		// Notificar lectura completada
		totalRows := len(rows) - 1
		notify("processing", fmt.Sprintf("Excel leído: %d filas en %.1fs", totalRows, readTime.Seconds()), 10, totalRows, 0)

		// Procesar headers
		headers := make([]string, len(rows[0]))
		seen := make(map[string]int)
		for i, col := range rows[0] {
			header := strings.TrimSpace(col)
			if header == "" {
				header = fmt.Sprintf("Columna_%d", i+1)
			}
			if count, exists := seen[header]; exists {
				seen[header] = count + 1
				header = fmt.Sprintf("%s_%d", header, count+1)
			} else {
				seen[header] = 1
			}
			headers[i] = header
		}

		log.Printf("📊 Headers: %d columnas", len(headers))

		// Convertir filas a registros EN PARALELO (OPTIMIZACIÓN)
		records := processRowsParallel(rows[1:], headers)

		log.Printf("📊 Registros válidos: %d", len(records))

		if len(records) == 0 {
			notify("error", "El Excel no contiene datos válidos", 0, 0, 0)
			deleteActiveProcess(userID)
			return
		}

		// Actualizar metadata (solo totalRecords, los headers ya fueron guardados por el backend de NestJS)
		ctx := context.Background()
		dbPool.Exec(ctx, `
			UPDATE excel_metadata 
			SET "totalRecords" = $1
			WHERE id = $2
		`, len(records), excelID)

		// Notificar inicio de inserción
		notify("inserting", fmt.Sprintf("Insertando %d registros...", len(records)), 15, len(records), 0)

		// Insertar registros en lotes (en paralelo si hay muchos)
		insertRecordsOptimized(ctx, excelID, userID, records, filename)

		// Completado
		elapsed := time.Since(startTime)
		log.Printf("✅ Excel %d completado: %d registros en %.2fs", excelID, len(records), elapsed.Seconds())
		notify("completed", fmt.Sprintf("✅ Completado: %d registros en %.1fs", len(records), elapsed.Seconds()), 100, len(records), len(records))

		// Limpiar después de 3 segundos
		time.Sleep(3 * time.Second)
		deleteActiveProcess(userID)
	}

	// ============================================================================
	// PROCESAMIENTO PARALELO DE FILAS
	// ============================================================================

	// processRowsParallel convierte filas de Excel a registros usando goroutines
	func processRowsParallel(rows [][]string, headers []string) []map[string]interface{} {
		if len(rows) == 0 {
			return []map[string]interface{}{}
		}

		numHeaders := len(headers)
		
		// ⚡ Usar todos los CPUs disponibles (hasta 12)
		numWorkers := runtime.NumCPU()
		if numWorkers > 12 {
			numWorkers = 12
		}

		type job struct {
			index int
			row   []string
		}
		
		type result struct {
			index  int
			record map[string]interface{}
		}

		jobs := make(chan job, len(rows))
		results := make(chan result, len(rows))

		// Lanzar workers
		var wg sync.WaitGroup
		for w := 0; w < numWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for job := range jobs {
					record := make(map[string]interface{}, numHeaders)
					isEmpty := true
					row := job.row
					
					for j := 0; j < numHeaders && j < len(row); j++ {
						value := strings.TrimSpace(row[j])
						if value != "" {
							record[headers[j]] = value
							isEmpty = false
						}
					}
					
					if !isEmpty {
						results <- result{index: job.index, record: record}
					}
				}
			}()
		}

		// Enviar trabajos
		go func() {
			for i, row := range rows {
				jobs <- job{index: i, row: row}
			}
			close(jobs)
		}()

		// Esperar y cerrar resultados
		go func() {
			wg.Wait()
			close(results)
		}()

		// Recolectar resultados
		recordsMap := make(map[int]map[string]interface{}, len(rows))
		for res := range results {
			recordsMap[res.index] = res.record
		}

		// Convertir a slice ordenado
		records := make([]map[string]interface{}, 0, len(recordsMap))
		for i := 0; i < len(rows); i++ {
			if record, exists := recordsMap[i]; exists {
				records = append(records, record)
			}
		}

		return records
	}

	// insertRecordsOptimized inserta registros en paralelo para máxima velocidad
	func insertRecordsOptimized(ctx context.Context, excelID, userID int, records []map[string]interface{}, filename string) {
		totalRecords := len(records)
		// ⚡ Batches de 25k = óptimo para COPY con PostgreSQL
		batchSize := 25000
		
		var processed atomic.Int32
		
		notify := func(progress float64, proc int) {
			scaledProgress := 20 + (progress * 0.79)
			notifyProgress(excelID, userID, &ProcessStatus{
				ExcelID:   excelID,
				Filename:  filename,
				Status:    "inserting",
				Message:   fmt.Sprintf("Insertando: %d/%d (%.1f%%)", proc, totalRecords, scaledProgress),
				Progress:  scaledProgress,
				Total:     totalRecords,
				Processed: proc,
			})
		}

		// ⚡ Usar inserción paralela para archivos grandes (>50k)
		useParallel := totalRecords > 50000
		
		if !useParallel {
			// Inserción secuencial para archivos pequeños
			insertRecordsSequential(ctx, excelID, userID, records, filename, &processed, notify)
		} else {
			// Inserción paralela para archivos grandes
			insertRecordsParallel(ctx, excelID, userID, records, filename, batchSize, &processed, notify)
		}
	}

	// insertRecordsSequential inserta registros de forma secuencial
	func insertRecordsSequential(ctx context.Context, excelID, userID int, records []map[string]interface{}, 
		filename string, processed *atomic.Int32, notify func(float64, int)) {
		
		totalRecords := len(records)
		batchSize := 10000 // Aumentado de 5k a 10k para menos overhead
		rowIndex := 0
		lastNotified := 0

		for i := 0; i < len(records); i += batchSize {
			end := i + batchSize
			if end > len(records) {
				end = len(records)
			}
			batch := records[i:end]

			// Preparar datos para COPY
			rows := make([][]interface{}, 0, len(batch))
			now := time.Now()
			
			for _, record := range batch {
				rowDataJSON, _ := json.Marshal(record)
				rows = append(rows, []interface{}{excelID, userID, rowIndex, string(rowDataJSON), now})
				rowIndex++
			}

			// Usar CopyFrom con retry
			maxRetries := 3
			var err error
			for retry := 0; retry < maxRetries; retry++ {
				_, err = dbPool.CopyFrom(
					ctx,
					pgx.Identifier{"dynamic_records"},
					[]string{"excel_id", "user_id", "rowIndex", "rowData", "createdAt"},
					pgx.CopyFromRows(rows),
				)
				
				if err == nil {
					break
				}
				
				if retry < maxRetries-1 {
					log.Printf("⚠️ Error insertando batch (intento %d/%d): %v", retry+1, maxRetries, err)
					time.Sleep(time.Duration(retry+1) * 100 * time.Millisecond)
				} else {
					log.Printf("❌ Error insertando batch: %v", err)
				}
			}

			proc := int(processed.Add(int32(len(batch))))
			progress := float64(proc) / float64(totalRecords) * 100

			// Notificar cada 5000 registros o al final
			if (proc - lastNotified >= 5000) || proc == totalRecords {
				log.Printf("📝 Excel %d: %d/%d registros (%.1f%%)", excelID, proc, totalRecords, progress)
				notify(progress, proc)
				lastNotified = proc
			}
		}
	}

	// insertRecordsParallel inserta registros en paralelo usando múltiples goroutines
	func insertRecordsParallel(ctx context.Context, excelID, userID int, records []map[string]interface{}, 
		filename string, batchSize int, processed *atomic.Int32, notify func(float64, int)) {
		
		totalRecords := len(records)
		
		// ⚡ Usar 10 workers para aprovechar el pool de conexiones (20 conns)
		numWorkers := 10
		
		type batch struct {
			records []map[string]interface{}
			startIdx int
		}
		
		jobs := make(chan batch, numWorkers*2)
		var wg sync.WaitGroup
		var notifyMux sync.Mutex // Mutex para sincronizar notificaciones
		lastNotified := 0

		// Lanzar workers
		for w := 0; w < numWorkers; w++ {
			wg.Add(1)
			go func(workerID int) {
				defer wg.Done()
				
				for job := range jobs {
					// Preparar datos para COPY
					rows := make([][]interface{}, 0, len(job.records))
					now := time.Now()
					
					for i, record := range job.records {
						rowDataJSON, _ := json.Marshal(record)
						rows = append(rows, []interface{}{excelID, userID, job.startIdx + i, string(rowDataJSON), now})
					}

					// Usar CopyFrom con retry
					maxRetries := 3
					var err error
					for retry := 0; retry < maxRetries; retry++ {
						_, err = dbPool.CopyFrom(
							ctx,
							pgx.Identifier{"dynamic_records"},
							[]string{"excel_id", "user_id", "rowIndex", "rowData", "createdAt"},
							pgx.CopyFromRows(rows),
						)
						
						if err == nil {
							break
						}
						
						if retry < maxRetries-1 {
							time.Sleep(time.Duration(retry+1) * 100 * time.Millisecond)
						}
					}

					if err != nil {
						log.Printf("❌ Worker %d error: %v", workerID, err)
					}

					// Actualizar progreso
					proc := int(processed.Add(int32(len(job.records))))
					progress := float64(proc) / float64(totalRecords) * 100

					// Notificar con sincronización para evitar notificaciones duplicadas
					notifyMux.Lock()
					shouldNotify := (proc - lastNotified >= 5000) || proc >= totalRecords
					if shouldNotify {
						lastNotified = proc
						notifyMux.Unlock()
						log.Printf("📝 Excel %d: %d/%d registros (%.1f%%)", excelID, proc, totalRecords, progress)
						notify(progress, proc)
					} else {
						notifyMux.Unlock()
					}
				}
			}(w)
		}

		// Enviar trabajos
		go func() {
			rowIndex := 0
			for i := 0; i < len(records); i += batchSize {
				end := i + batchSize
				if end > len(records) {
					end = len(records)
				}
				
				jobs <- batch{
					records: records[i:end],
					startIdx: rowIndex,
				}
				rowIndex += (end - i)
			}
			close(jobs)
		}()

		// Esperar a que terminen todos los workers
		wg.Wait()
		
		// Notificación final garantizada
		finalProc := int(processed.Load())
		if finalProc > lastNotified {
			progress := float64(finalProc) / float64(totalRecords) * 100
			log.Printf("📝 Excel %d: %d/%d registros (%.1f%%) - Final", excelID, finalProc, totalRecords, progress)
			notify(progress, finalProc)
		}
	}

	// ============================================================================
	// ENDPOINTS
	// ============================================================================

	func getActiveProcessEndpoint(c *fiber.Ctx) error {
		userIDStr := c.Params("user_id")
		userID, err := strconv.Atoi(userIDStr)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "user_id inválido"})
		}

		status := getActiveProcess(userID)
		if status != nil {
			log.Printf("📊 Proceso activo para usuario %d: Excel %d - %s", userID, status.ExcelID, status.Status)
			return c.JSON(fiber.Map{
				"hasActiveProcess": true,
				"excelId":          status.ExcelID,
				"filename":         status.Filename,
				"progress":         status.Progress,
				"total":            status.Total,
				"processed":        status.Processed,
				"status":           status.Status,
				"message":          status.Message,
			})
		}

		return c.JSON(fiber.Map{"hasActiveProcess": false})
	}

	// ============================================================================
	// CANCELAR PROCESO
	// ============================================================================

	func cancelProcessEndpoint(c *fiber.Ctx) error {
		excelIDStr := c.Params("excel_id")
		excelID, err := strconv.Atoi(excelIDStr)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "excel_id inválido"})
		}

		log.Printf("🔴 Cancelando proceso para Excel %d", excelID)

		// Marcar el proceso como cancelado
		setCancelledProcess(excelID)

		// Buscar y eliminar el proceso activo para cualquier usuario
		activeProcessMux.Lock()
		for userID, status := range activeProcesses {
			if status.ExcelID == excelID {
				log.Printf("🗑️ Eliminando proceso activo de usuario %d para Excel %d", userID, excelID)
				delete(activeProcesses, userID)
				break
			}
		}
		activeProcessMux.Unlock()

		return c.JSON(fiber.Map{
			"success": true,
			"message": fmt.Sprintf("Proceso %d marcado como cancelado", excelID),
		})
	}

	func healthCheck(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":  "healthy",
			"service": "excel-processor-go",
			"time":    time.Now().Format(time.RFC3339),
		})
	}

	// ============================================================================
	// ⚡ LEER SOLO CABECERAS (ULTRA RÁPIDO ~500ms)
	// ============================================================================

	type ReadHeadersRequest struct {
		FilePath string `json:"file_path"`
	}

	type ReadHeadersResponse struct {
		Success   bool     `json:"success"`
		Headers   []string `json:"headers"`
		TotalRows int      `json:"totalRows"`
		Duration  string   `json:"duration"`
		Error     string   `json:"error,omitempty"`
	}

	// readHeadersOnly - Lee SOLO la primera fila del Excel SIN cargar todo el archivo
	// Usa lectura directa del ZIP para ser ultra rápido (~500ms vs 50s)
	func readHeadersOnly(c *fiber.Ctx) error {
		startTime := time.Now()
		
		var req ReadHeadersRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(400).JSON(ReadHeadersResponse{
				Success: false,
				Error:   "JSON inválido: " + err.Error(),
			})
		}
		
		if req.FilePath == "" {
			return c.Status(400).JSON(ReadHeadersResponse{
				Success: false,
				Error:   "file_path es requerido",
			})
		}
		
		// Verificar que el archivo existe
		if _, err := os.Stat(req.FilePath); err != nil {
			return c.Status(400).JSON(ReadHeadersResponse{
				Success: false,
				Error:   "Archivo no encontrado: " + req.FilePath,
			})
		}
		
		// ⚡ MÉTODO RÁPIDO: Leer solo primera fila con excelize optimizado
		// Usamos OpenFile pero con un truco: cerrar inmediatamente después de leer la primera fila
		headers, totalRows, err := readFirstRowFast(req.FilePath)
		if err != nil {
			return c.Status(500).JSON(ReadHeadersResponse{
				Success: false,
				Error:   "Error leyendo cabeceras: " + err.Error(),
			})
		}
		
		// Procesar cabeceras (limpiar, evitar duplicados)
		seen := make(map[string]int)
		processedHeaders := make([]string, len(headers))
		for i, col := range headers {
			header := strings.TrimSpace(col)
			if header == "" {
				header = fmt.Sprintf("Columna_%d", i+1)
			}
			
			if count, exists := seen[header]; exists {
				seen[header] = count + 1
				header = fmt.Sprintf("%s_%d", header, count+1)
			} else {
				seen[header] = 1
			}
			processedHeaders[i] = header
		}
		
		duration := time.Since(startTime)
		log.Printf("⚡ Cabeceras leídas en %v: %d columnas, %d filas", duration, len(processedHeaders), totalRows)
		
		return c.JSON(ReadHeadersResponse{
			Success:   true,
			Headers:   processedHeaders,
			TotalRows: totalRows,
			Duration:  duration.String(),
		})
	}

	// ============================================================================
	// ⚡ LECTURA ULTRA OPTIMIZADA CON BUFFERS GRANDES Y PARALELISMO
	// ============================================================================

	// readExcelDirectFromZip - Lee TODO el Excel directamente del ZIP
	// ⚡ OPTIMIZADO: Buffers de 4MB, lectura paralela real
	func readExcelDirectFromZip(filePath string, progressCallback func(int)) ([]string, [][]string, error) {
		zipReader, err := zip.OpenReader(filePath)
		if err != nil {
			return nil, nil, fmt.Errorf("error abriendo ZIP: %w", err)
		}
		defer zipReader.Close()

		var sharedStringsFile, workbookFile, workbookRelsFile *zip.File
		sheetFiles := make(map[string]*zip.File)
		
		for _, f := range zipReader.File {
			switch f.Name {
			case "xl/sharedStrings.xml":
				sharedStringsFile = f
			case "xl/workbook.xml":
				workbookFile = f
			case "xl/_rels/workbook.xml.rels":
				workbookRelsFile = f
			}
			if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
				sheetFiles[f.Name] = f
			}
		}

		// Encontrar la primera hoja del workbook
		sheetFile, err := findFirstSheet(workbookFile, workbookRelsFile, sheetFiles)
		if err != nil {
			// Fallback: usar sheet1.xml si existe
			if sf, ok := sheetFiles["xl/worksheets/sheet1.xml"]; ok {
				sheetFile = sf
				log.Printf("⚠️ No se pudo leer workbook, usando sheet1.xml como fallback")
			} else {
				return nil, nil, fmt.Errorf("no se encontró ninguna hoja: %w", err)
			}
		}
		
		log.Printf("📊 Procesando hoja: %s", sheetFile.Name)

		// ⚡ OPTIMIZACIÓN: Leer sharedStrings en paralelo MIENTRAS se prepara el sheet
		var sharedStrings []string
		var ssErr error
		ssDone := make(chan struct{})
		
		if sharedStringsFile != nil {
			go func() {
				defer close(ssDone)
				sharedStrings, ssErr = readAllSharedStringsUltraFast(sharedStringsFile)
			}()
		} else {
			close(ssDone)
		}

		// ⚡ Esperar sharedStrings (necesario antes de procesar filas)
		<-ssDone
		if ssErr != nil {
			log.Printf("⚠️ Error leyendo sharedStrings: %v", ssErr)
		}

		// Leer todas las filas con buffer optimizado
		return readAllRowsUltraFast(sheetFile, sharedStrings, progressCallback)
	}

	// ⚡ ULTRA FAST: Lee sharedStrings con buffer de 4MB y menos allocations
	func readAllSharedStringsUltraFast(ssFile *zip.File) ([]string, error) {
		rc, err := ssFile.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()

		// ⚡ Buffer de 4MB para lectura ultra rápida
		decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 4*1024*1024))
		
		// ⚡ Pre-alocar slice grande (estimar ~200k strings para archivos grandes)
		result := make([]string, 0, 200000)
		
		inSi := false
		inT := false
		var currentText strings.Builder
		currentText.Grow(512) // Pre-alocar más capacidad

		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return result, nil
			}

			switch t := token.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "si":
					inSi = true
					currentText.Reset()
				case "t":
					if inSi {
						inT = true
					}
				}
			case xml.CharData:
				if inT && inSi {
					currentText.Write(t)
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "t":
					inT = false
				case "si":
					result = append(result, currentText.String())
					inSi = false
				}
			}
		}
		return result, nil
	}

	// ⚡ ULTRA FAST: Lee todas las filas con buffer de 4MB
	func readAllRowsUltraFast(sheetFile *zip.File, sharedStrings []string, progressCallback func(int)) ([]string, [][]string, error) {
		rc, err := sheetFile.Open()
		if err != nil {
			return nil, nil, err
		}
		defer rc.Close()

		var headers []string
		// ⚡ Pre-alocar para ~500k filas (archivos muy grandes)
		rows := make([][]string, 0, 500000)
		
		// ⚡ Buffer de 4MB para lectura ultra rápida
		decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 4*1024*1024))
		
		// ⚡ Pre-alocar slice de celdas (100 columnas típico)
		currentRow := make([]xmlCell, 0, 100)
		var currentCell xmlCell
		inRow := false
		inValue := false
		inInlineString := false  // Para <is> (inline string)
		inInlineText := false    // Para <t> dentro de <is>
		var inlineTextBuilder strings.Builder
		rowNumber := 0
		ssLen := len(sharedStrings)

		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return headers, rows, nil
			}

			switch t := token.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "row":
					inRow = true
					currentRow = currentRow[:0] // Reusar slice sin allocation
					rowNumber++
				case "c":
					if inRow {
						currentCell = xmlCell{}
						inlineTextBuilder.Reset()
						for _, attr := range t.Attr {
							switch attr.Name.Local {
							case "t":
								currentCell.Type = attr.Value
							case "r":
								currentCell.Ref = attr.Value
							}
						}
					}
				case "v":
					if inRow {
						inValue = true
					}
				case "is":
					// Inline string - el valor está dentro de <is><t>...</t></is>
					if inRow {
						inInlineString = true
					}
				case "t":
					// Elemento <t> puede estar dentro de <is> (inline string)
					if inRow && inInlineString {
						inInlineText = true
					}
				}
			case xml.CharData:
				if inRow {
					if inValue {
						currentCell.Value = string(t)
					} else if inInlineText {
						// Acumular texto de inline string
						inlineTextBuilder.Write(t)
					}
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "v":
					inValue = false
				case "t":
					inInlineText = false
				case "is":
					// Al cerrar <is>, guardar el valor acumulado
					if inRow && inInlineString {
						currentCell.Value = inlineTextBuilder.String()
						inInlineString = false
					}
				case "c":
					if inRow {
						currentRow = append(currentRow, currentCell)
					}
				case "row":
					if inRow {
						// ⚡ Determinar el número máximo de columnas basado en las referencias de celda
						maxCol := 0
						for _, cell := range currentRow {
							if cell.Ref != "" {
								colIdx := columnIndex(cell.Ref)
								if colIdx >= maxCol {
									maxCol = colIdx + 1
								}
							}
						}
						// Si no hay referencias, usar el número de celdas directamente
						if maxCol == 0 {
							maxCol = len(currentRow)
						}
						
						// ⚡ Convertir celdas a strings usando las referencias de columna
						rowStrings := make([]string, maxCol)
						for _, cell := range currentRow {
							var colIdx int
							if cell.Ref != "" {
								colIdx = columnIndex(cell.Ref)
							} else {
								continue // Saltar celdas sin referencia
							}
							
							if colIdx >= 0 && colIdx < len(rowStrings) {
								if cell.Type == "s" && cell.Value != "" {
									if idx, err := strconv.Atoi(cell.Value); err == nil && idx < ssLen {
										rowStrings[colIdx] = sharedStrings[idx]
									}
								} else {
									// Formatear números con máximo 2 decimales
									rowStrings[colIdx] = formatNumber(cell.Value)
								}
							}
						}
						
						if rowNumber == 1 {
							// Procesar headers
							seen := make(map[string]int, len(rowStrings))
							headers = make([]string, len(rowStrings))
							for i, col := range rowStrings {
								header := strings.TrimSpace(col)
								if header == "" {
									header = fmt.Sprintf("Columna_%d", i+1)
								}
								if count, exists := seen[header]; exists {
									seen[header] = count + 1
									header = fmt.Sprintf("%s_%d", header, count+1)
								} else {
									seen[header] = 1
								}
								headers[i] = header
							}
						} else {
							// Para filas de datos, ajustar al número de headers si existe
							if len(headers) > 0 && len(rowStrings) < len(headers) {
								// Extender el slice para coincidir con headers
								extended := make([]string, len(headers))
								copy(extended, rowStrings)
								rowStrings = extended
							} else if len(headers) > 0 && len(rowStrings) > len(headers) {
								// Truncar si hay más columnas que headers
								rowStrings = rowStrings[:len(headers)]
							}
							rows = append(rows, rowStrings)
							if progressCallback != nil && len(rows)%50000 == 0 {
								progressCallback(len(rows))
							}
						}
						inRow = false
					}
				}
			}
		}
		
		// Callback final
		if progressCallback != nil {
			progressCallback(len(rows))
		}
		
		return headers, rows, nil
	}

	// readExcelWithExcelize - Fallback usando excelize
	func readExcelWithExcelize(tempPath string) ([]string, [][]string, error) {
		f, err := excelize.OpenFile(tempPath, excelize.Options{
			UnzipSizeLimit:    10 << 30,
			UnzipXMLSizeLimit: 10 << 30,
			RawCellValue:      true,
		})
		if err != nil {
			return nil, nil, err
		}
		defer f.Close()

		sheets := f.GetSheetList()
		if len(sheets) == 0 {
			return nil, nil, fmt.Errorf("Excel sin hojas")
		}

		rowsIter, err := f.Rows(sheets[0])
		if err != nil {
			return nil, nil, err
		}
		defer rowsIter.Close()

		var headers []string
		var allRows [][]string
		isFirstRow := true

		for rowsIter.Next() {
			row, _ := rowsIter.Columns()
			if isFirstRow {
				seen := make(map[string]int)
				headers = make([]string, len(row))
				for i, col := range row {
					header := strings.TrimSpace(col)
					if header == "" {
						header = fmt.Sprintf("Columna_%d", i+1)
					}
					if count, exists := seen[header]; exists {
						seen[header] = count + 1
						header = fmt.Sprintf("%s_%d", header, count+1)
					} else {
						seen[header] = 1
					}
					headers[i] = header
				}
				isFirstRow = false
			} else {
				allRows = append(allRows, row)
			}
		}
		return headers, allRows, nil
	}

	// ============================================================================
	// ⚡ LECTURA SOLO PRIMERA FILA - ULTRA RÁPIDA (~1-3 segundos)
	// ============================================================================

	// findFirstSheet - Encuentra el archivo de la PRIMERA hoja del workbook
	// Lee workbook.xml para obtener el orden de hojas y workbook.xml.rels para los archivos
	func findFirstSheet(workbookFile, workbookRelsFile *zip.File, sheetFiles map[string]*zip.File) (*zip.File, error) {
		if workbookFile == nil {
			return nil, fmt.Errorf("workbook.xml no encontrado")
		}

		// Paso 1: Leer workbook.xml para obtener el rId de la primera hoja
		rc, err := workbookFile.Open()
		if err != nil {
			return nil, err
		}
		
		var firstSheetRId string
		decoder := xml.NewDecoder(rc)
		
		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				rc.Close()
				return nil, err
			}
			
			if startEl, ok := token.(xml.StartElement); ok {
				if startEl.Name.Local == "sheet" {
					// Primera hoja encontrada - obtener r:id
					for _, attr := range startEl.Attr {
						if attr.Name.Local == "id" {
							firstSheetRId = attr.Value
							break
						}
					}
					if firstSheetRId != "" {
						break // Solo necesitamos la primera
					}
				}
			}
		}
		rc.Close()
		
		if firstSheetRId == "" {
			return nil, fmt.Errorf("no se encontró ninguna hoja en workbook.xml")
		}
		
		log.Printf("🔍 Primera hoja tiene rId: %s", firstSheetRId)
		
		// Paso 2: Leer workbook.xml.rels para obtener el archivo correspondiente
		if workbookRelsFile == nil {
			return nil, fmt.Errorf("workbook.xml.rels no encontrado")
		}
		
		rc2, err := workbookRelsFile.Open()
		if err != nil {
			return nil, err
		}
		defer rc2.Close()
		
		var sheetPath string
		decoder2 := xml.NewDecoder(rc2)
		
		for {
			token, err := decoder2.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			
			if startEl, ok := token.(xml.StartElement); ok {
				if startEl.Name.Local == "Relationship" {
					var id, target string
					for _, attr := range startEl.Attr {
						switch attr.Name.Local {
						case "Id":
							id = attr.Value
						case "Target":
							target = attr.Value
						}
					}
					if id == firstSheetRId {
						sheetPath = target
						break
					}
				}
			}
		}
		
		if sheetPath == "" {
			return nil, fmt.Errorf("no se encontró el archivo para rId: %s", firstSheetRId)
		}
		
		// Construir path completo (los targets son relativos a xl/)
		fullPath := "xl/" + sheetPath
		// Limpiar path (quitar ../ si existe)
		fullPath = strings.ReplaceAll(fullPath, "xl/../", "")
		
		log.Printf("🔍 Archivo de primera hoja: %s", fullPath)
		
		if sheetFile, ok := sheetFiles[fullPath]; ok {
			return sheetFile, nil
		}
		
		return nil, fmt.Errorf("archivo de hoja no encontrado: %s", fullPath)
	}

	// readFirstRowFast - Lee SOLO la primera fila directamente del ZIP
	// NO usa excelize - lee los bytes directamente del archivo ZIP
	func readFirstRowFast(filePath string) ([]string, int, error) {
		// Abrir el archivo ZIP
		zipReader, err := zip.OpenReader(filePath)
		if err != nil {
			return nil, 0, fmt.Errorf("error abriendo ZIP: %w", err)
		}
		defer zipReader.Close()

		// Buscar archivos necesarios
		var sharedStringsFile, workbookFile, workbookRelsFile *zip.File
		sheetFiles := make(map[string]*zip.File) // Mapa de todos los sheets
		
		for _, f := range zipReader.File {
			switch f.Name {
			case "xl/sharedStrings.xml":
				sharedStringsFile = f
			case "xl/workbook.xml":
				workbookFile = f
			case "xl/_rels/workbook.xml.rels":
				workbookRelsFile = f
			}
			// Guardar todos los archivos de hojas
			if strings.HasPrefix(f.Name, "xl/worksheets/sheet") && strings.HasSuffix(f.Name, ".xml") {
				sheetFiles[f.Name] = f
			}
		}

		// Encontrar la primera hoja del workbook
		sheetFile, err := findFirstSheet(workbookFile, workbookRelsFile, sheetFiles)
		if err != nil {
			// Fallback: usar sheet1.xml si existe
			if sf, ok := sheetFiles["xl/worksheets/sheet1.xml"]; ok {
				sheetFile = sf
				log.Printf("⚠️ No se pudo leer workbook, usando sheet1.xml como fallback")
			} else {
				return nil, 0, fmt.Errorf("no se encontró ninguna hoja: %w", err)
			}
		}
		
		log.Printf("📊 Usando hoja: %s", sheetFile.Name)

		// PASO 1: Leer dimensión y primera fila de la hoja
		firstRowCells, totalRows, err := readFirstRowFromXML(sheetFile)
		if err != nil {
			return nil, 0, err
		}

		// PASO 2: Si hay strings compartidos, leer SOLO los que necesitamos
		sharedStrings := make(map[int]string)
		if sharedStringsFile != nil {
			// Identificar qué índices de strings necesitamos
			neededIndices := make(map[int]bool)
			for _, cell := range firstRowCells {
				if cell.Type == "s" && cell.Value != "" {
					if idx, err := strconv.Atoi(cell.Value); err == nil {
						neededIndices[idx] = true
					}
				}
			}

			if len(neededIndices) > 0 {
				sharedStrings, err = readSharedStringsPartial(sharedStringsFile, neededIndices)
				if err != nil {
					log.Printf("⚠️ Error leyendo sharedStrings: %v", err)
				}
			}
		}

		// PASO 3: Determinar el número máximo de columnas basado en las referencias
		maxCol := 0
		for _, cell := range firstRowCells {
			if cell.Ref != "" {
				colIdx := columnIndex(cell.Ref)
				if colIdx >= maxCol {
					maxCol = colIdx + 1
				}
			}
		}
		// Si no hay referencias, usar el número de celdas directamente
		if maxCol == 0 {
			maxCol = len(firstRowCells)
		}
		
		// PASO 4: Construir array de headers usando las referencias de columna
		headers := make([]string, maxCol)
		for _, cell := range firstRowCells {
			var colIdx int
			if cell.Ref != "" {
				colIdx = columnIndex(cell.Ref)
			} else {
				continue // Saltar celdas sin referencia
			}
			
			if colIdx >= 0 && colIdx < len(headers) {
				if cell.Type == "s" && cell.Value != "" {
					if idx, err := strconv.Atoi(cell.Value); err == nil {
						headers[colIdx] = sharedStrings[idx]
					}
				} else {
					headers[colIdx] = cell.Value
				}
			}
		}

		return headers, totalRows, nil
	}

	// Estructura para celdas del XML
	type xmlCell struct {
		Type  string // "s" = shared string, "inlineStr" = inline string, "" = valor directo
		Value string
		Ref   string // Referencia de celda (ej: "A1", "B5", "AA123")
	}

	// columnIndex convierte una referencia de columna de Excel (A, B, ..., Z, AA, AB) a un índice 0-based
	func columnIndex(ref string) int {
		// Extraer solo las letras de la referencia
		letters := ""
		for _, c := range ref {
			if c >= 'A' && c <= 'Z' {
				letters += string(c)
			} else {
				break
			}
		}
		
		if letters == "" {
			return -1
		}
		
		result := 0
		for i, c := range letters {
			result = result*26 + int(c-'A'+1)
			_ = i
		}
		return result - 1 // Convertir a 0-based
	}

	// readFirstRowFromXML - Lee solo la primera fila del sheet XML
	// ⚡ OPTIMIZADO: Buffer de 1MB, regex precompilado, salida temprana
	var dimensionRegex = regexp.MustCompile(`[A-Z]+(\d+)$`)

	func readFirstRowFromXML(sheetFile *zip.File) ([]xmlCell, int, error) {
		rc, err := sheetFile.Open()
		if err != nil {
			return nil, 0, err
		}
		defer rc.Close()

		// ⚡ Buffer de 1MB para lectura más rápida
		decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 1024*1024))
		
		cells := make([]xmlCell, 0, 100) // Pre-alocar para ~100 columnas
		totalRows := 0
		inFirstRow := false
		var currentCell xmlCell
		inValue := false
		inInlineString := false  // Para manejar <is> (inline string)
		inInlineText := false    // Para manejar <t> dentro de <is>
		foundFirstRow := false
		var inlineTextBuilder strings.Builder // Para acumular texto de inline strings

		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, 0, err
			}

			switch t := token.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "dimension":
					// Extraer total de filas del atributo ref (ej: "A1:CG258537")
					for _, attr := range t.Attr {
						if attr.Name.Local == "ref" {
							matches := dimensionRegex.FindStringSubmatch(attr.Value)
							if len(matches) > 1 {
								if rows, err := strconv.Atoi(matches[1]); err == nil {
									totalRows = rows - 1 // -1 porque la primera fila son headers
								}
							}
							break
						}
					}
				case "row":
					// ⚡ Si ya encontramos la primera fila, salir inmediatamente
					if foundFirstRow {
						return cells, totalRows, nil
					}
					// Verificar si es la primera fila
					for _, attr := range t.Attr {
						if attr.Name.Local == "r" {
							if attr.Value == "1" {
								inFirstRow = true
							}
							break
						}
					}
				case "c":
					if inFirstRow {
						currentCell = xmlCell{}
						inlineTextBuilder.Reset()
						for _, attr := range t.Attr {
							switch attr.Name.Local {
							case "t":
								currentCell.Type = attr.Value
							case "r":
								currentCell.Ref = attr.Value
							}
						}
					}
				case "v":
					if inFirstRow {
						inValue = true
					}
				case "is":
					// Inline string - el valor está dentro de <is><t>...</t></is>
					if inFirstRow {
						inInlineString = true
					}
				case "t":
					// Elemento <t> puede estar dentro de <is> (inline string)
					if inFirstRow && inInlineString {
						inInlineText = true
					}
				}
			case xml.CharData:
				if inFirstRow {
					if inValue {
						currentCell.Value = string(t)
					} else if inInlineText {
						// Acumular texto de inline string (puede haber múltiples <t>)
						inlineTextBuilder.Write(t)
					}
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "v":
					inValue = false
				case "t":
					inInlineText = false
				case "is":
					// Al cerrar <is>, guardar el valor acumulado
					if inFirstRow && inInlineString {
						currentCell.Value = inlineTextBuilder.String()
						inInlineString = false
					}
				case "c":
					if inFirstRow {
						cells = append(cells, currentCell)
					}
				case "row":
					if inFirstRow {
						foundFirstRow = true
						// ⚡ Terminamos con la primera fila, salir inmediatamente
						return cells, totalRows, nil
					}
				}
			}
		}

		return cells, totalRows, nil
	}

	// readSharedStringsPartial - Lee SOLO los strings que necesitamos del sharedStrings.xml
	// ⚡ OPTIMIZADO: Buffer de 1MB, salida temprana
	func readSharedStringsPartial(ssFile *zip.File, neededIndices map[int]bool) (map[int]string, error) {
		rc, err := ssFile.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()

		result := make(map[int]string, len(neededIndices))
		maxNeeded := 0
		for idx := range neededIndices {
			if idx > maxNeeded {
				maxNeeded = idx
			}
		}

		// ⚡ Buffer de 1MB para lectura rápida
		decoder := xml.NewDecoder(bufio.NewReaderSize(rc, 1024*1024))
		currentIndex := 0
		inSi := false
		inT := false
		var currentText strings.Builder
		currentText.Grow(256)
		foundCount := 0
		totalNeeded := len(neededIndices)

		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return result, nil
			}

			switch t := token.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "si":
					inSi = true
					currentText.Reset()
				case "t":
					if inSi {
						inT = true
					}
				}
			case xml.CharData:
				if inT && inSi {
					currentText.Write(t)
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "t":
					inT = false
				case "si":
					if neededIndices[currentIndex] {
						result[currentIndex] = currentText.String()
						foundCount++
						if foundCount >= totalNeeded {
							return result, nil // ⚡ Ya encontramos todos, salir
						}
					}
					currentIndex++
					inSi = false
					
					// ⚡ Si ya pasamos el índice máximo, salir inmediatamente
					if currentIndex > maxNeeded {
						return result, nil
					}
				}
			}
		}

		return result, nil
	}

	// ⚡ NUEVO: Procesar desde un path local (sin transferir archivo por HTTP)
	// NestJS ya guardó el archivo, solo nos pasa el path
	type ProcessFromPathRequest struct {
		ExcelID         int      `json:"excel_id"`
		UserID          int      `json:"user_id"`
		Filename        string   `json:"filename"`
		UploadedBy      string   `json:"uploaded_by"`
		TempPath        string   `json:"temp_path"`
		SelectedHeaders []string `json:"selected_headers"`
	}

	func processFromPath(c *fiber.Ctx) error {
		var req ProcessFromPathRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "JSON inválido: " + err.Error()})
		}

		if req.ExcelID == 0 || req.UserID == 0 || req.TempPath == "" {
			return c.Status(400).JSON(fiber.Map{"error": "Faltan parámetros requeridos"})
		}

		// Verificar que el archivo existe
		fileInfo, err := os.Stat(req.TempPath)
		if err != nil {
			log.Printf("❌ Archivo no encontrado: %s - %v", req.TempPath, err)
			return c.Status(400).JSON(fiber.Map{"error": "Archivo no encontrado"})
		}

		fileSizeMB := float64(fileInfo.Size()) / (1024 * 1024)
		log.Printf("📊 Procesando desde path: %s (%.1f MB) - Excel %d", req.TempPath, fileSizeMB, req.ExcelID)

		// Procesar en background
		go processExcelInBackgroundDirect(req.ExcelID, req.UserID, req.Filename, req.UploadedBy, req.TempPath, fileSizeMB, true)

		return c.JSON(fiber.Map{
			"success": true,
			"message": "Procesamiento iniciado desde path local",
			"excelId": req.ExcelID,
		})
	}

	// ============================================================================
	// MAIN
	// ============================================================================

	func main() {
		// Cargar variables de entorno
		envPath := "../.env"
		if _, err := os.Stat(envPath); err == nil {
			godotenv.Load(envPath)
			log.Printf("📋 Variables cargadas desde %s", envPath)
		} else {
			godotenv.Load()
		}

		// Configurar URL del backend
		backendURL = os.Getenv("BACKEND_URL")
		if backendURL == "" {
			backendURL = "http://localhost:3000"
		}
		log.Printf("🔗 Backend URL: %s", backendURL)

		// Conectar a PostgreSQL
		dbHost := os.Getenv("DB_HOST")
		if dbHost == "" {
			dbHost = "localhost"
		}
		dbPort := os.Getenv("DB_PORT")
		if dbPort == "" {
			dbPort = "5432"
		}
		dbUser := os.Getenv("DB_USER")
		if dbUser == "" {
			dbUser = "root"
		}
		dbPass := os.Getenv("DB_PASSWORD")
		if dbPass == "" {
			dbPass = "password"
		}
		dbName := os.Getenv("DB_NAME")
		if dbName == "" {
			dbName = "autochat_db"
		}

		connStr := fmt.Sprintf("postgres://%s:%s@%s:%s/%s", dbUser, dbPass, dbHost, dbPort, dbName)

		// Configurar pool optimizado para operaciones masivas
		poolConfig, err := pgxpool.ParseConfig(connStr)
		if err != nil {
			log.Fatalf("❌ Error parseando config: %v", err)
		}

		// Optimizaciones del pool
		poolConfig.MaxConns = 20                              // Más conexiones concurrentes
		poolConfig.MinConns = 5                               // Mantener conexiones listas
		poolConfig.MaxConnLifetime = time.Hour                // Reciclar conexiones cada hora
		poolConfig.MaxConnIdleTime = 30 * time.Minute        // Cerrar conexiones idle después de 30min
		poolConfig.HealthCheckPeriod = 1 * time.Minute       // Verificar salud del pool
		poolConfig.ConnConfig.ConnectTimeout = 10 * time.Second // Timeout de conexión

		// Crear pool con configuración optimizada
		dbPool, err = pgxpool.NewWithConfig(context.Background(), poolConfig)
		if err != nil {
			log.Fatalf("❌ Error conectando a PostgreSQL: %v", err)
		}
		defer dbPool.Close()

		log.Printf("✅ Conectado a PostgreSQL (%s:%s/%s) - Pool: %d conns (min: %d)", 
			dbHost, dbPort, dbName, poolConfig.MaxConns, poolConfig.MinConns)

		// Configurar Fiber
		app := fiber.New(fiber.Config{
			BodyLimit: 500 * 1024 * 1024, // 500MB
		})

		app.Use(logger.New())
		app.Use(cors.New(cors.Config{
			AllowOrigins: "*",
			AllowMethods: "GET,POST,PUT,DELETE",
			AllowHeaders: "Origin, Content-Type, Accept, Authorization",
		}))

		// Rutas
		app.Get("/health", healthCheck)
		app.Post("/read-headers", readHeadersOnly)       // ⚡ Leer solo cabeceras (~100ms)
		app.Post("/process", processExcel)
		app.Post("/process-from-path", processFromPath)  // Procesar desde path local
		app.Get("/active-process/:user_id", getActiveProcessEndpoint)
		app.Delete("/cancel/:excel_id", cancelProcessEndpoint) // Cancelar proceso

		// Iniciar servidor
		port := os.Getenv("EXCEL_PROCESSOR_PORT")
		if port == "" {
			port = "8001"
		}

		log.Printf("🚀 Excel Processor (Go) corriendo en http://localhost:%s", port)
		log.Fatal(app.Listen(":" + port))
	}
